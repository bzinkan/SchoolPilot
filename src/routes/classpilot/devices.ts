import { Router } from "express";
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
  getHeartbeatsByDevice,
  createEvent,
  getStudentById,
  getStudentsBySchool,
  linkStudentDevice,
  createStudent,
  startStudentSession,
  searchStudents,
  getSchoolByDomain,
  getSchoolById,
  getSettingsForSchool,
  getStudentsForDevice,
  getActiveStudentForDevice,
  setActiveStudentForDevice,
} from "../../services/storage.js";
import { createStudentToken } from "../../services/deviceJwt.js";
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

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

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
// Tracking window enforcement (item #2)
// ============================================================================
function isWithinTrackingWindow(settings: {
  enableTrackingHours: boolean | null;
  trackingStartTime: string | null;
  trackingEndTime: string | null;
  trackingDays: string[] | null;
  schoolTimezone: string | null;
}): boolean {
  if (!settings.enableTrackingHours) return true; // tracking hours disabled = always track

  const tz = settings.schoolTimezone || "America/New_York";
  let now: Date;
  try {
    const dateStr = new Date().toLocaleString("en-US", { timeZone: tz });
    now = new Date(dateStr);
  } catch {
    now = new Date();
  }

  // Check day of week
  if (settings.trackingDays && settings.trackingDays.length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = dayNames[now.getDay()]!;
    if (!settings.trackingDays.includes(today)) return false;
  }

  // Check time range
  if (settings.trackingStartTime && settings.trackingEndTime) {
    const [startH, startM] = settings.trackingStartTime.split(":").map(Number);
    const [endH, endM] = settings.trackingEndTime.split(":").map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = (startH ?? 8) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 15) * 60 + (endM ?? 0);
    if (currentMinutes < startMinutes || currentMinutes > endMinutes) return false;
  }

  return true;
}

// ============================================================================
// School Status Endpoints
// ============================================================================

// POST /api/classpilot/school/status - Check school status from email domain or token
router.post("/school/status", async (req, res, next) => {
  try {
    const { studentEmail, studentToken } = req.body;

    // Try token-based lookup first
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

    const domain = studentEmail.split("@")[1]?.toLowerCase();
    if (!domain) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const school = await getSchoolByDomain(domain);
    if (!school) {
      return res.status(401).json({ error: "Unknown school domain" });
    }

    return res.json({
      schoolId: school.id,
      schoolActive: school.status === "active" || school.status === "trial",
      planStatus: school.planStatus || "active",
      status: school.status,
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
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Device & Student Registration
// ============================================================================

// POST /api/classpilot/register - Generic device registration (no student) (item #7)
router.post("/register", async (req, res, next) => {
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
router.post("/extension/register", async (req, res, next) => {
  try {
    const { deviceId, deviceName, studentEmail, studentName, schoolId: explicitSchoolId, classId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId required" });
    }

    // Resolve school: either explicit schoolId or from email domain
    let resolvedSchoolId = explicitSchoolId;
    let school;

    if (!resolvedSchoolId && studentEmail) {
      const domain = studentEmail.split("@")[1]?.toLowerCase();
      if (domain) {
        school = await getSchoolByDomain(domain);
        if (school) resolvedSchoolId = school.id;
      }
    }

    if (resolvedSchoolId && !school) {
      school = await getSchoolById(resolvedSchoolId);
    }

    if (!resolvedSchoolId) {
      return res.status(401).json({ error: "No school found for this email domain" });
    }

    // Check school is active
    if (school && school.status !== "active" && school.status !== "trial") {
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
      const existing = await searchStudents(resolvedSchoolId, { search: studentEmail });
      let student = existing[0];

      if (!student) {
        const nameParts = (studentName || studentEmail.split("@")[0]).split(/\s+/);
        student = await createStudent({
          schoolId: resolvedSchoolId,
          firstName: nameParts[0] || studentEmail.split("@")[0],
          lastName: nameParts.slice(1).join(" ") || "",
          email: studentEmail,
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
router.post("/register-student", async (req, res, next) => {
  try {
    const { deviceId, studentEmail, gradeLevel, firstName, lastName, schoolId } = req.body;
    if (!deviceId || !studentEmail || !schoolId) {
      return res.status(400).json({ error: "deviceId, studentEmail, and schoolId required" });
    }

    // Find or create student
    const existing = await searchStudents(schoolId, { search: studentEmail });
    let student = existing[0];

    if (!student) {
      student = await createStudent({
        schoolId,
        firstName: firstName || studentEmail.split("@")[0],
        lastName: lastName || "",
        email: studentEmail,
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
      flightPathActive, activeFlightPathName,
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

    // --- Tracking window enforcement (item #2) ---
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      const afterMode = schoolSettings.afterHoursMode || "off";
      if (afterMode === "off") {
        return res.status(204).send();
      }
      // "limited" or "full" mode: continue processing
    }

    // --- Get school for planStatus (item #3) ---
    const school = await getSchoolById(schoolId);
    if (!school || (school.status !== "active" && school.status !== "trial")) {
      return res.status(402).json({ planStatus: "inactive" });
    }

    // --- Save heartbeat to DB (item #1 — capture all fields) ---
    await createHeartbeat({
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

        // Broadcast classification to teachers
        const classificationUpdate = {
          type: "ai-classification",
          studentId,
          deviceId,
          classification,
        };
        broadcastToTeachersLocal(schoolId, classificationUpdate);
        void publishWS({ kind: "staff", schoolId }, classificationUpdate);

        // Safety alert — broadcast urgently
        if (classification.safetyAlert) {
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
        }
      }).catch(() => { /* non-blocking */ });
    }

    // --- Return planStatus (item #3) ---
    return res.json({ ok: true, planStatus: school.planStatus || "active" });
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
    const heartbeats = await getHeartbeatsByDevice(param(req, "deviceId"), limit);
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
      const { deviceIds, ...payload } = req.body;

      if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
        return res.status(400).json({ error: "deviceIds array required" });
      }

      const message = { type: "remote-control", command: type, ...payload };

      for (const deviceId of deviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
      }

      await publishWS(
        { kind: "students", schoolId, targetDeviceIds: deviceIds },
        message
      );

      return res.json({ ok: true, sent: deviceIds.length });
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
    const { deviceIds, flightPathId, flightPathName, allowedDomains } = req.body;

    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      return res.status(400).json({ error: "deviceIds array required" });
    }

    const message = {
      type: "remote-control",
      command: "apply-flight-path",
      flightPathId,
      flightPathName,
      allowedDomains,
    };

    for (const deviceId of deviceIds) {
      sendToDeviceLocal(schoolId, deviceId, message);
      await setFlightPathStatus(deviceId, {
        active: true,
        flightPathId,
        flightPathName,
        appliedAt: Date.now(),
      });
    }

    await publishWS({ kind: "students", schoolId, targetDeviceIds: deviceIds }, message);

    return res.json({ ok: true, sent: deviceIds.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/remote/remove-flight-path - Remove flight path
router.post("/remote/remove-flight-path", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds } = req.body;

    if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
      return res.status(400).json({ error: "deviceIds array required" });
    }

    const message = { type: "remote-control", command: "remove-flight-path" };

    for (const deviceId of deviceIds) {
      sendToDeviceLocal(schoolId, deviceId, message);
      await setFlightPathStatus(deviceId, { active: false, appliedAt: Date.now() });
    }

    await publishWS({ kind: "students", schoolId, targetDeviceIds: deviceIds }, message);

    return res.json({ ok: true, sent: deviceIds.length });
  } catch (err) {
    next(err);
  }
});

export default router;
