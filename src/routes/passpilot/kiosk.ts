import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { kioskLookupSchema, kioskCheckoutSchema } from "../../schema/validation.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";

// Strict rate limiter for public kiosk endpoints
const kioskLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { error: "Too many kiosk requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
import { eq, and } from "drizzle-orm";
import { productLicenses } from "../../schema/core.js";
import db from "../../db.js";
import {
  getSchoolById,
  getStudentByIdNumber,
  getStudentById,
  getStudentsByGrade,
  getActivePassForStudent,
  getActivePassesByGrade,
  getActivePassesByClass,
  createLegacyPass,
  createCanonicalPass,
  expireOverduePasses,
  getKioskStudentState,
  returnKioskPassForStudent,
  getUserById,
  getGradesBySchool,
  updateCanonicalKioskClass,
  updateLegacyKioskClass,
  updateUser,
  getSettingsForSchool,
} from "../../services/storage.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";
import { comparePassword } from "../../util/password.js";
import {
  canAccessGrade,
  canAccessPasspilotClass,
  getCanonicalClassForSchool,
  getPasspilotClassSourceForSchool,
  getRequestPassPilotRole,
  hasPasspilotCanonicalClassCapability,
  isPassPilotManager,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";
import {
  getPasspilotClasses,
  getPasspilotClassRoster,
  normalizePasspilotPass,
} from "../../services/passpilotClasses.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

function requireKioskClassCapability(req: Parameters<typeof hasPasspilotCanonicalClassCapability>[0], res: any) {
  if (hasPasspilotCanonicalClassCapability(req)) return true;
  res.status(426).json({
    error: "This school uses the ClassPilot class model. Refresh or update PassPilot before continuing.",
    code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
    requiredClassModel: "classpilot-groups-v1",
  });
  return false;
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

// Helper: validate kiosk is enabled and the kiosk PIN is correct.
// These endpoints are PUBLIC (no auth) and return student data, so a PIN is
// REQUIRED: a school UUID alone (visible in URLs/QR codes) must not unlock
// badge-number → student lookup. Admins set the PIN in Setup → Settings.
async function validateKiosk(schoolId: string, kioskPin?: string) {
  const school = await getSchoolById(schoolId);
  if (!school) return { error: "School not found", status: 400, school: null };
  // Check PassPilot license
  const [license] = await db.select().from(productLicenses).where(and(eq(productLicenses.schoolId, schoolId), eq(productLicenses.product, "PASSPILOT"), eq(productLicenses.status, "active"))).limit(1);
  if (!license) return { error: "PassPilot license required", status: 403, school: null };
  if (school.kioskEnabled === false) return { error: "Kiosk is not enabled", status: 403, school: null };
  if (!school.kioskPinHash) {
    return {
      error: "Kiosk PIN not configured. An administrator must set a kiosk PIN in PassPilot Setup → Settings.",
      status: 403,
      school: null,
    };
  }
  if (!kioskPin || !(await comparePassword(kioskPin, school.kioskPinHash))) {
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

    await runWithTenantContext({ schoolId }, async () => {
    const student = await getStudentByIdNumber(schoolId, parsed.data.studentIdNumber);
    if (!student) {
      return res.json({ error: "Student not found", student: null, activePass: null });
    }

    const kioskState = await getKioskStudentState(
      schoolId,
      student.id,
      hasPasspilotCanonicalClassCapability(req)
    );
    if (!kioskState.enrolled) {
      return res.json({ error: "Student not found", student: null, activePass: null });
    }
    if (kioskState.hasActivePassInAnotherClass) {
      return res.status(409).json({
        error: "Student already has an active pass",
        student: null,
        activePass: null,
      });
    }
    const activePass = kioskState.activePass ?? undefined;

    return res.json({
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
      },
      activePass: activePass ? await normalizePasspilotPass(activePass, schoolId) : null,
    });
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

    await runWithTenantContext({ schoolId }, async () => {
    const student = await getStudentById(parsed.data.studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(400).json({ error: "Student not found" });
    }

    // Enforce school hours
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return res.status(403).json({ error: "Passes cannot be issued outside school hours" });
    }

    // Expire lapsed passes first so a stale one doesn't block a new checkout.
    await expireOverduePasses(schoolId);

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
        kioskName = activatingUser.displayName || null;
      }
    }

    // Look up class name from kioskGradeId
    let className: string | null = null;
    const classSource = await getPasspilotClassSourceForSchool(schoolId);
    if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const selectedClassId = classSource === "classpilot_groups"
      ? school.kioskClasspilotGroupId
      : (parsed.data.classId || school.kioskGradeId);
    if (classSource === "classpilot_groups") {
      if (!selectedClassId) {
        return res.status(400).json({ error: "A kiosk class must be selected before checkout" });
      }
      if (
        parsed.data.classId &&
        parsed.data.classId !== school.kioskClasspilotGroupId
      ) {
        return res.status(400).json({ error: "Checkout class does not match the configured kiosk class" });
      }
      const group = await getCanonicalClassForSchool(selectedClassId, schoolId);
      if (!group) return res.status(400).json({ error: "Kiosk class is not active" });
      className = group.name;
    } else if (selectedClassId) {
      const allGrades = await getGradesBySchool(schoolId);
      const grade = allGrades.find((g) => g.id === selectedClassId);
      if (grade) className = grade.name;
    }

    // Combine: "7th Science" or just "Science" or just "7th" or null
    const kioskLabel = [className, kioskName].filter(Boolean).join(" ");

    let pass;
    try {
      const commonPass = {
          schoolId,
          studentId: student.id,
          teacherId: school.kioskActivatedByUserId || null,
          destination: parsed.data.destination,
          customDestination:
            parsed.data.destination === "custom"
              ? (parsed.data.customDestination || null)
              : null,
          status: "active" as const,
          duration: passDuration,
          expiresAt,
          issuedVia: "kiosk" as const,
          notes: kioskLabel || null,
        };
      pass = classSource === "classpilot_groups"
        ? await createCanonicalPass(
            { ...commonPass, classId: selectedClassId! },
            { kiosk: true }
          )
        : await createLegacyPass({ ...commonPass, gradeId: selectedClassId || student.gradeId || null });
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ error: "Student already has an active pass" });
      }
      throw err;
    }

    return res.status(201).json({ pass: await normalizePasspilotPass(pass, schoolId) });
    });
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
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }

    await runWithTenantContext({ schoolId }, async () => {
    const pass = await returnKioskPassForStudent(
      schoolId,
      studentId,
      hasPasspilotCanonicalClassCapability(req)
    );
    if (!pass) {
      return res.status(400).json({ error: "No active pass found" });
    }
    return res.json({ pass: await normalizePasspilotPass(pass, schoolId) });
    });
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
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const inventory = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClasses(schoolId, { userId: "kiosk", manager: true })
    );
    if (inventory.source === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const classes = inventory.source === "classpilot_groups"
      ? inventory.classes.filter((entry) => entry.classId === school.kioskClasspilotGroupId)
      : inventory.classes;
    return res.json({ source: inventory.source, classes, grades: classes });
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

    const classId = (req.query.classId || req.query.gradeId) as string;
    if (!classId) {
      return res.status(400).json({ error: "classId required" });
    }

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    const source = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClassSourceForSchool(schoolId)
    );
    if (source === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    if (
      source === "classpilot_groups" &&
      (!school.kioskClasspilotGroupId || classId !== school.kioskClasspilotGroupId)
    ) {
      return res.status(409).json({
        error: "The selected class does not match the configured kiosk class.",
        code: "PASSPILOT_KIOSK_CLASS_CHANGED",
      });
    }

    const rosterState = await runWithTenantContext({ schoolId }, async () => {
      if (source === "classpilot_groups") {
        const roster = await getPasspilotClassRoster(schoolId, classId, { userId: "kiosk", manager: true });
        if (!roster) return null;
        return {
          studentsList: roster.students,
          activePasses: await getActivePassesByClass(schoolId, classId),
        };
      }
      return {
        studentsList: await getStudentsByGrade(schoolId, classId),
        activePasses: await getActivePassesByGrade(schoolId, classId),
      };
    });
    if (!rosterState) {
      return res.status(409).json({
        error: "The configured kiosk class is no longer active. Ask an administrator to select an active ClassPilot class.",
        code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
        source: "classpilot_groups",
      });
    }
    const { studentsList, activePasses } = rosterState;

    const passMap = new Map(activePasses.map((p) => [p.studentId, p]));

    const result = studentsList.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      classId,
      gradeId: source === "legacy_grades" ? classId : null,
      studentIdNumber: s.studentIdNumber || null,
      status: s.status,
      activePass: passMap.get(s.id) || null,
    }));

    return res.json({ source, classId, students: result });
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

    const kioskPin = req.headers["x-kiosk-pin"] as string | undefined;
    const { error, status, school } = await validateKiosk(schoolId, kioskPin);
    if (error || !school) return res.status(status).json({ error });

    let kioskName: string | null = null;
    if (school.kioskActivatedByUserId) {
      const user = await getUserById(school.kioskActivatedByUserId);
      if (user) kioskName = user.displayName || null;
    }

    const classSource = await runWithTenantContext({ schoolId }, () =>
      getPasspilotClassSourceForSchool(schoolId)
    );
    if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
    const classId = classSource === "classpilot_groups"
      ? school.kioskClasspilotGroupId || null
      : school.kioskGradeId || null;
    if (classSource === "classpilot_groups" && classId) {
      const roster = await runWithTenantContext({ schoolId }, () =>
        getPasspilotClassRoster(schoolId, classId, { userId: "kiosk", manager: true })
      );
      if (!roster) {
        return res.status(409).json({
          error: "The configured kiosk class is no longer active. Ask an administrator to select an active ClassPilot class.",
          code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
          source: "classpilot_groups",
        });
      }
    }
    return res.json({
      source: classSource,
      classId,
      gradeId: classSource === "legacy_grades" ? classId : null,
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
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
  async (req, res, next) => {
    try {
      const { gradeId, classId, kioskName } = req.body;
      const schoolId = res.locals.schoolId!;
      const role = await getRequestPassPilotRole(req, res);

      // Update school kiosk settings
      const classSource = await getPasspilotClassSourceForSchool(schoolId);
      if (classSource === "classpilot_groups" && !requireKioskClassCapability(req, res)) return;
      const selectedClassId = classId !== undefined ? classId : gradeId;
      if (selectedClassId !== undefined) {
        if (selectedClassId && !(await canAccessPasspilotClass(req.authUser!, schoolId, selectedClassId, role))) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
        if (classSource === "classpilot_groups") {
          await updateCanonicalKioskClass(
            schoolId,
            selectedClassId || null,
            req.authUser!.id,
            isPassPilotManager(role)
          );
        } else {
          await updateLegacyKioskClass(
            schoolId,
            selectedClassId || null,
            req.authUser!.id
          );
        }
      }

      // Update user kiosk name (stored in displayName for now, or membership kioskName)
      if (kioskName !== undefined) {
        await updateUser(req.authUser!.id, { displayName: kioskName });
      }

      const school = await getSchoolById(schoolId);
      return res.json({
        ok: true,
        source: classSource,
        classId: classSource === "classpilot_groups"
          ? school?.kioskClasspilotGroupId || null
          : school?.kioskGradeId || null,
        gradeId: classSource === "legacy_grades" ? school?.kioskGradeId || null : null,
        kioskName: kioskName || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
