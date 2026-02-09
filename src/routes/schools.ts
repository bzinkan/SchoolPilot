import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireRole, requireSuperAdmin } from "../middleware/requireRole.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import {
  createSchoolSchema,
  updateSchoolSchema,
  createGradeSchema,
} from "../schema/validation.js";
import {
  getSchoolById,
  createSchool,
  updateSchool,
  softDeleteSchool,
  getAllSchools,
  getProductLicenses,
  createProductLicense,
  deleteProductLicense,
  getGradesBySchool,
  createGrade,
  updateGrade,
  deleteGrade,
  getTeacherGrades,
  assignTeacherGrade,
  removeTeacherGrade,
} from "../services/storage.js";

const router = Router();

// Helper: extract a route param as string
function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

// All school routes require authentication
router.use(authenticate);

// ============================================================================
// School CRUD (admin/super-admin)
// ============================================================================

// GET /api/schools - List all schools (super admin)
router.get("/", requireSuperAdmin, async (req, res, next) => {
  try {
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const schoolsList = await getAllSchools({ search, status });
    return res.json({ schools: schoolsList });
  } catch (err) {
    next(err);
  }
});

// POST /api/schools - Create school (super admin)
router.post("/", requireSuperAdmin, async (req, res, next) => {
  try {
    const parsed = createSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const { products, timezone, ...schoolData } = parsed.data;

    const school = await createSchool({
      ...schoolData,
      schoolTimezone: timezone || "America/New_York",
    });

    if (products && products.length > 0) {
      for (const product of products) {
        await createProductLicense({
          schoolId: school.id,
          product,
          status: "active",
        });
      }
    }

    const licenses = await getProductLicenses(school.id);
    return res.status(201).json({ school, licenses });
  } catch (err) {
    next(err);
  }
});

// GET /api/schools/:schoolId - Get school details
router.get("/:schoolId", requireSchoolContext, async (req, res, next) => {
  try {
    const school = await getSchoolById(param(req, "schoolId"));
    if (!school || school.deletedAt) {
      return res.status(404).json({ error: "School not found" });
    }

    const licenses = await getProductLicenses(school.id);
    return res.json({ school, licenses });
  } catch (err) {
    next(err);
  }
});

// PUT /api/schools/:schoolId - Update school
router.put(
  "/:schoolId",
  requireSchoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const parsed = updateSchoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const school = await updateSchool(param(req, "schoolId"), parsed.data);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      return res.json({ school });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/schools/:schoolId - Partial update
router.patch(
  "/:schoolId",
  requireSchoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const parsed = updateSchoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const school = await updateSchool(param(req, "schoolId"), parsed.data);
      if (!school) {
        return res.status(404).json({ error: "School not found" });
      }

      return res.json({ school });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/schools/:schoolId - Soft delete (super admin)
router.delete("/:schoolId", requireSuperAdmin, async (req, res, next) => {
  try {
    const school = await softDeleteSchool(param(req, "schoolId"));
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/schools/:schoolId/suspend
router.post("/:schoolId/suspend", requireSuperAdmin, async (req, res, next) => {
  try {
    const school = await updateSchool(param(req, "schoolId"), {
      status: "suspended",
      isActive: false,
    });
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    return res.json({ school });
  } catch (err) {
    next(err);
  }
});

// POST /api/schools/:schoolId/restore
router.post("/:schoolId/restore", requireSuperAdmin, async (req, res, next) => {
  try {
    const school = await updateSchool(param(req, "schoolId"), {
      status: "active",
      isActive: true,
    });
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    return res.json({ school });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Product Licenses
// ============================================================================

// GET /api/schools/:schoolId/licenses
router.get(
  "/:schoolId/licenses",
  requireSchoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const licenses = await getProductLicenses(param(req, "schoolId"));
      return res.json({ licenses });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/schools/:schoolId/licenses
router.post(
  "/:schoolId/licenses",
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const { product, status } = req.body;
      if (!product || !["PASSPILOT", "GOPILOT", "CLASSPILOT"].includes(product)) {
        return res.status(400).json({ error: "Valid product required" });
      }

      const license = await createProductLicense({
        schoolId: param(req, "schoolId"),
        product,
        status: status || "active",
      });
      return res.status(201).json({ license });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/schools/:schoolId/licenses/:licenseId
router.delete(
  "/:schoolId/licenses/:licenseId",
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      const deleted = await deleteProductLicense(param(req, "licenseId"));
      if (!deleted) {
        return res.status(404).json({ error: "License not found" });
      }
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Grades (PassPilot classes)
// ============================================================================

// GET /api/schools/:schoolId/grades
router.get(
  "/:schoolId/grades",
  requireSchoolContext,
  requireActiveSchool,
  async (req, res, next) => {
    try {
      const gradesList = await getGradesBySchool(res.locals.schoolId!);
      return res.json({ grades: gradesList });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/schools/:schoolId/grades
router.post(
  "/:schoolId/grades",
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const parsed = createGradeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const grade = await createGrade({
        schoolId: res.locals.schoolId!,
        ...parsed.data,
      });
      return res.status(201).json({ grade });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/schools/:schoolId/grades/:gradeId
router.put(
  "/:schoolId/grades/:gradeId",
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const grade = await updateGrade(param(req, "gradeId"), req.body);
      if (!grade) {
        return res.status(404).json({ error: "Grade not found" });
      }
      return res.json({ grade });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/schools/:schoolId/grades/:gradeId
router.delete(
  "/:schoolId/grades/:gradeId",
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const deleted = await deleteGrade(param(req, "gradeId"));
      if (!deleted) {
        return res.status(404).json({ error: "Grade not found" });
      }
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Teacher-Grade Assignments
// ============================================================================

// GET /api/schools/:schoolId/teacher-grades/:teacherId
router.get(
  "/:schoolId/teacher-grades/:teacherId",
  requireSchoolContext,
  requireActiveSchool,
  async (req, res, next) => {
    try {
      const assignments = await getTeacherGrades(param(req, "teacherId"));
      return res.json({
        assignments: assignments.map((a) => ({
          id: a.teacherGrade.id,
          gradeId: a.teacherGrade.gradeId,
          gradeName: a.grade.name,
          assignedAt: a.teacherGrade.assignedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/schools/:schoolId/teacher-grades
router.post(
  "/:schoolId/teacher-grades",
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { teacherId, gradeId } = req.body;
      if (!teacherId || !gradeId) {
        return res
          .status(400)
          .json({ error: "teacherId and gradeId required" });
      }

      const assignment = await assignTeacherGrade(teacherId, gradeId);
      return res.status(201).json({ assignment });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/schools/:schoolId/teacher-grades
router.delete(
  "/:schoolId/teacher-grades",
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { teacherId, gradeId } = req.body;
      if (!teacherId || !gradeId) {
        return res
          .status(400)
          .json({ error: "teacherId and gradeId required" });
      }

      await removeTeacherGrade(teacherId, gradeId);
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
