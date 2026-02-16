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

// POST /api/classpilot/school/status - Check school status from email domain
router.post("/school/status", async (req, res, next) => {
  try {
    const { studentEmail } = req.body;
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
router.get("/school/status", async (req, res) => {
  return res.json({ status: "ok", message: "Use POST with studentEmail" });
});

// GET /api/classpilot/extension/settings - Extension settings (requires device JWT)
router.get("/extension/settings", requireDeviceAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    return res.json({
      enableTrackingHours: false,
      trackingStartTime: null,
      trackingEndTime: null,
      trackingDays: null,
      schoolTimezone: school.schoolTimezone || null,
      afterHoursMode: "off",
      maxTabsPerStudent: null,
    });
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
      return res.status(400).json({ error: "deviceId and schoolId required" });
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

// POST /api/classpilot/device/heartbeat - Device sends heartbeat (device JWT auth)
router.post("/device/heartbeat", requireDeviceAuth, async (req, res, next) => {
  try {
    const { activeTabUrl, activeTabTitle, visibilityState, screenLocked, allOpenTabs, favicon } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const studentEmail = res.locals.studentEmail as string;

    // Save heartbeat to DB
    const heartbeat = await createHeartbeat({
      deviceId,
      studentId,
      studentEmail,
      schoolId,
      activeTabTitle: activeTabTitle || "Unknown",
      activeTabUrl: activeTabUrl || null,
      favicon: favicon || null,
      screenLocked: screenLocked || false,
      flightPathActive: false,
    });

    // Broadcast update to teachers
    const update = {
      type: "student-update",
      studentId,
      deviceId,
      schoolId,
      activeTabUrl,
      activeTabTitle,
      visibilityState,
      screenLocked,
      timestamp: new Date().toISOString(),
    };

    broadcastToTeachersLocal(schoolId, update);
    await publishWS({ kind: "staff", schoolId }, update);

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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
      // In-memory fallback handled by the route cache
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

    // Try Redis first
    let data = await getScreenshot(deviceId);
    if (!data) {
      // Fallback to in-memory
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

// POST /api/classpilot/device/event - Log device event
router.post("/device/event", requireDeviceAuth, async (req, res, next) => {
  try {
    const { eventType, metadata } = req.body;
    const deviceId = res.locals.deviceId as string;
    const studentId = res.locals.studentId as string;

    await createEvent({
      deviceId,
      studentId,
      eventType: eventType || "unknown",
      metadata: metadata || null,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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
