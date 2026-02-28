import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import { kioskLookupSchema, kioskCheckoutSchema } from "../../schema/validation.js";

// Strict rate limiter for public kiosk endpoints
const kioskLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { error: "Too many kiosk requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
import {
  getSchoolById,
  getStudentByIdNumber,
  getStudentById,
  getStudentsByGrade,
  getActivePassForStudent,
  getActivePassesByGrade,
  createPass,
  returnPass,
  getUserById,
  getGradesBySchool,
  updateSchool,
  updateUser,
  getSettingsForSchool,
} from "../../services/storage.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

// Helper: extract schoolId from header or query
function getKioskSchoolId(req: { headers: Record<string, unknown>; query: Record<string, unknown> }): string | null {
  return (
    (req.headers["x-school-id"] as string) ||
    (req.query.school as string) ||
    (req.query.schoolId as string) ||
    null
  );
}

// Helper: validate kiosk is enabled and PIN matches (if set)
async function validateKiosk(schoolId: string, kioskPin?: string) {
  const school = await getSchoolById(schoolId);
  if (!school) return { error: "School not found", status: 404, school: null };
  if (!school.kioskEnabled) return { error: "Kiosk is not enabled", status: 403, school: null };
  // If the school has a kiosk PIN, require it on every request
  if ((school as any).kioskPin && (school as any).kioskPin !== kioskPin) {
    return { error: "Invalid kiosk PIN", status: 401, school: null };
  }
  return { error: null, status: 200, school };
}

// ============================================================================
// Public kiosk endpoints (no auth required, school ID from header)
// ============================================================================

// POST /api/passpilot/kiosk/lookup - Student lookup by badge ID
router.post("/lookup", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error) return res.status(status).json({ error });

    const parsed = kioskLookupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Student ID number required" });
    }

    const student = await getStudentByIdNumber(schoolId, parsed.data.studentIdNumber);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const activePass = await getActivePassForStudent(student.id, schoolId);

    return res.json({
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
      },
      activePass: activePass || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/checkout - Self-checkout (create pass from kiosk)
router.post("/checkout", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const parsed = kioskCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const student = await getStudentById(parsed.data.studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Enforce school hours
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return res.status(403).json({ error: "Passes cannot be issued outside school hours" });
    }

    // Check for existing active pass
    const activePass = await getActivePassForStudent(student.id, schoolId);
    if (activePass) {
      return res.status(409).json({ error: "Student already has an active pass" });
    }

    const passDuration = school.defaultPassDuration || 5;
    const expiresAt = new Date(Date.now() + passDuration * 60 * 1000);

    // Get kiosk name from activating user
    let kioskName: string | null = null;
    if (school.kioskActivatedByUserId) {
      const activatingUser = await getUserById(school.kioskActivatedByUserId);
      if (activatingUser) {
        // Check for kioskName on their membership (stored there in SchoolPilot)
        kioskName = activatingUser.displayName || null;
      }
    }

    const pass = await createPass({
      schoolId,
      studentId: student.id,
      teacherId: school.kioskActivatedByUserId || null,
      gradeId: student.gradeId || null,
      destination: parsed.data.destination,
      customDestination:
        parsed.data.destination === "custom"
          ? (parsed.data.customDestination || null)
          : null,
      status: "active",
      duration: passDuration,
      expiresAt,
      issuedVia: "kiosk",
      notes: kioskName,
    });

    return res.status(201).json({ pass });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/kiosk/checkin - Return pass from kiosk
router.post("/checkin", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status } = await validateKiosk(schoolId, kioskPin);
    if (error) return res.status(status).json({ error });

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }

    const activePass = await getActivePassForStudent(studentId, schoolId);
    if (!activePass) {
      return res.status(404).json({ error: "No active pass found" });
    }

    const pass = await returnPass(activePass.id, schoolId);
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/grades - List grades for kiosk
router.get("/grades", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status } = await validateKiosk(schoolId, kioskPin);
    if (error) return res.status(status).json({ error });

    const gradesList = await getGradesBySchool(schoolId);
    return res.json({ grades: gradesList });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/students - List students for a grade with active pass status
router.get("/students", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const gradeId = req.query.gradeId as string;
    if (!gradeId) {
      return res.status(400).json({ error: "gradeId required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status } = await validateKiosk(schoolId, kioskPin);
    if (error) return res.status(status).json({ error });

    const [studentsList, activePasses] = await Promise.all([
      getStudentsByGrade(schoolId, gradeId),
      getActivePassesByGrade(schoolId, gradeId),
    ]);

    const passMap = new Map(activePasses.map((p) => [p.studentId, p]));

    const result = studentsList.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      gradeId: s.gradeId,
      status: s.status,
      activePass: passMap.get(s.id) || null,
    }));

    return res.json({ students: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/config - Get kiosk configuration
router.get("/config", kioskLimiter, async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    let kioskName: string | null = null;
    if (school.kioskActivatedByUserId) {
      const user = await getUserById(school.kioskActivatedByUserId);
      if (user) kioskName = user.displayName || null;
    }

    return res.json({
      gradeId: school.kioskGradeId || null,
      kioskName,
      kioskEnabled: school.kioskEnabled,
      kioskRequiresApproval: school.kioskRequiresApproval,
      defaultPassDuration: school.defaultPassDuration,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Authenticated kiosk configuration
// ============================================================================

// PUT /api/passpilot/kiosk/config - Configure kiosk (requires auth)
router.put(
  "/config",
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin", "teacher"),
  async (req, res, next) => {
    try {
      const { gradeId, kioskName } = req.body;

      // Update school kiosk settings
      if (gradeId !== undefined) {
        await updateSchool(res.locals.schoolId!, {
          kioskGradeId: gradeId || null,
          kioskActivatedByUserId: req.authUser!.id,
        });
      }

      // Update user kiosk name (stored in displayName for now, or membership kioskName)
      if (kioskName !== undefined) {
        await updateUser(req.authUser!.id, { displayName: kioskName });
      }

      const school = await getSchoolById(res.locals.schoolId!);
      return res.json({
        ok: true,
        gradeId: school?.kioskGradeId || null,
        kioskName: kioskName || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
