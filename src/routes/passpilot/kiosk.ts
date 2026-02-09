import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import { kioskLookupSchema, kioskCheckoutSchema } from "../../schema/validation.js";
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
} from "../../services/storage.js";

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

// Helper: validate kiosk is enabled
async function validateKiosk(schoolId: string) {
  const school = await getSchoolById(schoolId);
  if (!school) return { error: "School not found", status: 404, school: null };
  if (!school.kioskEnabled) return { error: "Kiosk is not enabled", status: 403, school: null };
  return { error: null, status: 200, school };
}

// ============================================================================
// Public kiosk endpoints (no auth required, school ID from header)
// ============================================================================

// POST /api/passpilot/kiosk/lookup - Student lookup by badge ID
router.post("/lookup", async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const { error, status, school } = await validateKiosk(schoolId);
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
router.post("/checkout", async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const { error, status, school } = await validateKiosk(schoolId);
    if (error || !school) return res.status(status).json({ error });

    const parsed = kioskCheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const student = await getStudentById(parsed.data.studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
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
router.post("/checkin", async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required (x-school-id header)" });
    }

    const { error, status } = await validateKiosk(schoolId);
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
router.get("/grades", async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const { error, status } = await validateKiosk(schoolId);
    if (error) return res.status(status).json({ error });

    const gradesList = await getGradesBySchool(schoolId);
    return res.json({ grades: gradesList });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/kiosk/students - List students for a grade with active pass status
router.get("/students", async (req, res, next) => {
  try {
    const schoolId = getKioskSchoolId(req);
    if (!schoolId) {
      return res.status(400).json({ error: "School ID required" });
    }

    const gradeId = req.query.gradeId as string;
    if (!gradeId) {
      return res.status(400).json({ error: "gradeId required" });
    }

    const { error, status } = await validateKiosk(schoolId);
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
router.get("/config", async (req, res, next) => {
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
