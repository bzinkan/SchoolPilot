import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireRole } from "../middleware/requireRole.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import {
  createStudentSchema,
  updateStudentSchema,
} from "../schema/validation.js";
import {
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  searchStudents,
  bulkCreateStudents,
} from "../services/storage.js";
import type { InsertStudent } from "../schema/students.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

router.use(authenticate);

const schoolContext = [requireSchoolContext, requireActiveSchool] as const;

// ============================================================================
// Student CRUD
// ============================================================================

// GET /api/students - List students (school-scoped)
router.get("/", ...schoolContext, async (req, res, next) => {
  try {
    const { search, gradeLevel, gradeId, homeroomId, status } = req.query as Record<string, string | undefined>;

    const studentsList = await searchStudents(res.locals.schoolId!, {
      search,
      gradeLevel,
      gradeId,
      homeroomId,
      status: status || "active",
    });

    return res.json({ students: studentsList });
  } catch (err) {
    next(err);
  }
});

// POST /api/students - Create student
router.post(
  "/",
  ...schoolContext,
  requireRole("admin", "teacher", "office_staff"),
  async (req, res, next) => {
    try {
      const body = { ...req.body };
      if (body.name && !body.firstName) {
        const parts = body.name.trim().split(/\s+/);
        body.firstName = parts[0] || "";
        body.lastName = parts.slice(1).join(" ") || "";
        delete body.name;
      }

      const parsed = createStudentSchema.safeParse(body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const data: InsertStudent = {
        schoolId: res.locals.schoolId!,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email || null,
        emailLc: parsed.data.email?.toLowerCase() || null,
        studentIdNumber: parsed.data.studentIdNumber || null,
        gradeId: parsed.data.gradeId || null,
        gradeLevel: parsed.data.gradeLevel || null,
        homeroomId: parsed.data.homeroomId || null,
        dismissalType: parsed.data.dismissalType || "car",
        busRoute: parsed.data.busRoute || null,
      };

      const student = await createStudent(data);
      return res.status(201).json({ student });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/students/bulk - Bulk create students
router.post(
  "/bulk",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { students: studentData } = req.body;
      if (!Array.isArray(studentData) || studentData.length === 0) {
        return res
          .status(400)
          .json({ error: "Array of students required" });
      }

      const toInsert: InsertStudent[] = [];
      const errors: { index: number; error: string }[] = [];

      for (let i = 0; i < studentData.length; i++) {
        const item = { ...studentData[i] };
        if (item.name && !item.firstName) {
          const parts = item.name.trim().split(/\s+/);
          item.firstName = parts[0] || "";
          item.lastName = parts.slice(1).join(" ") || "";
        }

        const parsed = createStudentSchema.safeParse(item);
        if (!parsed.success) {
          errors.push({
            index: i,
            error: parsed.error.errors[0]?.message || "Invalid input",
          });
          continue;
        }

        toInsert.push({
          schoolId: res.locals.schoolId!,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          email: parsed.data.email || null,
          emailLc: parsed.data.email?.toLowerCase() || null,
          studentIdNumber: parsed.data.studentIdNumber || null,
          gradeId: parsed.data.gradeId || null,
          gradeLevel: parsed.data.gradeLevel || null,
          homeroomId: parsed.data.homeroomId || null,
          dismissalType: parsed.data.dismissalType || "car",
          busRoute: parsed.data.busRoute || null,
        });
      }

      const created = await bulkCreateStudents(toInsert);
      return res.status(201).json({
        imported: created.length,
        errors: errors.length > 0 ? errors : undefined,
        total: studentData.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/students/csv-template - Download CSV template
router.get(
  "/csv-template",
  ...schoolContext,
  async (_req, res) => {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=students-template.csv");
    return res.send("firstName,lastName,studentIdNumber,gradeLevel\n");
  }
);

// Shared import-csv handler (used by both /import-csv and /import)
const importCsvHandler = async (req: any, res: any, next: any) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Array of row objects required" });
    }

    const toInsert: InsertStudent[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const normalized: Record<string, string> = {};
      for (const [key, val] of Object.entries(raw)) {
        const k = key.toLowerCase().replace(/[\s_-]+/g, "");
        normalized[k] = String(val ?? "").trim();
      }

      let firstName = normalized["firstname"] || normalized["first"] || "";
      let lastName = normalized["lastname"] || normalized["last"] || "";

      if (!firstName && !lastName) {
        const fullName = normalized["name"] || normalized["fullname"] || "";
        if (fullName) {
          const parts = fullName.split(/\s+/);
          firstName = parts[0] || "";
          lastName = parts.slice(1).join(" ") || "";
        }
      }

      if (!firstName || !lastName) {
        errors.push({ row: i + 1, error: "Missing first or last name" });
        continue;
      }

      const email = normalized["email"] || null;
      const studentIdNumber =
        normalized["studentidnumber"] ||
        normalized["studentid"] ||
        normalized["id"] ||
        normalized["badgeid"] ||
        null;
      const gradeLevel = normalized["gradelevel"] || normalized["grade"] || null;
      const dismissalType = normalized["dismissaltype"] || normalized["dismissal"] || null;
      const busRoute =
        normalized["busroute"] || normalized["bus"] || normalized["bus#"] || null;

      toInsert.push({
        schoolId: res.locals.schoolId!,
        firstName,
        lastName,
        email,
        emailLc: email?.toLowerCase() || null,
        studentIdNumber,
        gradeLevel,
        dismissalType: dismissalType || "car",
        busRoute,
      });
    }

    const created = await bulkCreateStudents(toInsert);
    return res.status(201).json({
      imported: created.length,
      errors: errors.length > 0 ? errors : undefined,
      total: rows.length,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/students/import - Alias for import-csv (GoPilot compatibility)
router.post(
  "/import",
  ...schoolContext,
  requireRole("admin"),
  importCsvHandler
);

// POST /api/students/import-csv - CSV import
router.post(
  "/import-csv",
  ...schoolContext,
  requireRole("admin"),
  importCsvHandler
);

// PUT /api/students/bulk-update - Bulk update students (GoPilot)
router.put(
  "/bulk-update",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { updates } = req.body;
      if (!Array.isArray(updates)) {
        return res.status(400).json({ error: "Array of updates required" });
      }
      const results: unknown[] = [];
      for (const item of updates) {
        if (item.id) {
          const updated = await updateStudent(item.id, item);
          if (updated) results.push(updated);
        }
      }
      return res.json({ updated: results.length, students: results });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/students/:studentId
router.get("/:studentId", ...schoolContext, async (req, res, next) => {
  try {
    const student = await getStudentById(param(req, "studentId"));
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    return res.json({ student });
  } catch (err) {
    next(err);
  }
});

// PUT /api/students/:studentId
router.put(
  "/:studentId",
  ...schoolContext,
  requireRole("admin", "teacher", "office_staff"),
  async (req, res, next) => {
    try {
      const existing = await getStudentById(param(req, "studentId"));
      if (!existing || existing.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }

      const parsed = updateStudentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const updateData: Record<string, unknown> = { ...parsed.data };
      if (parsed.data.email !== undefined) {
        updateData.emailLc = parsed.data.email?.toLowerCase() || null;
      }
      for (const key of ["gradeId", "homeroomId", "studentIdNumber", "gradeLevel"]) {
        if (updateData[key] === "") updateData[key] = null;
      }

      const student = await updateStudent(param(req, "studentId"), updateData);
      return res.json({ student });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/students/:studentId
router.patch(
  "/:studentId",
  ...schoolContext,
  requireRole("admin", "teacher", "office_staff"),
  async (req, res, next) => {
    try {
      const existing = await getStudentById(param(req, "studentId"));
      if (!existing || existing.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }

      const parsed = updateStudentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const updateData: Record<string, unknown> = { ...parsed.data };
      if (parsed.data.email !== undefined) {
        updateData.emailLc = parsed.data.email?.toLowerCase() || null;
      }
      for (const key of ["gradeId", "homeroomId", "studentIdNumber", "gradeLevel"]) {
        if (updateData[key] === "") updateData[key] = null;
      }

      const student = await updateStudent(param(req, "studentId"), updateData);
      return res.json({ student });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/students/:studentId
router.delete(
  "/:studentId",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const existing = await getStudentById(param(req, "studentId"));
      if (!existing || existing.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }

      await deleteStudent(param(req, "studentId"));
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
