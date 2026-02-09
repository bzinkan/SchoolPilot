import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { issuePassSchema } from "../../schema/validation.js";
import {
  getActivePassesBySchool,
  getActivePassForStudent,
  getPassHistory,
  getPassById,
  createPass,
  returnPass,
  cancelPass,
  expireOverduePasses,
  getStudentById,
  getStudentsBySchool,
  getUserById,
  getGradesBySchool,
  getTeacherGrades,
  getSchoolById,
} from "../../services/storage.js";
import type { Pass } from "../../schema/passpilot.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

// All pass routes require auth + school context + active school + PassPilot license
router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT")
);

// Enrich passes with student/teacher/grade data
async function enrichPasses(rawPasses: Pass[], schoolId: string) {
  if (rawPasses.length === 0) return [];

  const [allStudents, allGrades] = await Promise.all([
    getStudentsBySchool(schoolId),
    getGradesBySchool(schoolId),
  ]);

  const studentMap = new Map(allStudents.map((s) => [s.id, s]));
  const gradeMap = new Map(allGrades.map((g) => [g.id, g]));

  // Collect unique teacher IDs
  const teacherIds = [...new Set(rawPasses.map((p) => p.teacherId).filter(Boolean))] as string[];
  const teacherMap = new Map<string, { id: string; firstName: string; lastName: string; displayName: string | null }>();
  for (const tid of teacherIds) {
    const user = await getUserById(tid);
    if (user) teacherMap.set(tid, user);
  }

  return rawPasses.map((pass) => {
    const student = studentMap.get(pass.studentId);
    const teacher = pass.teacherId ? teacherMap.get(pass.teacherId) : null;
    const grade = pass.gradeId ? gradeMap.get(pass.gradeId) : null;

    return {
      ...pass,
      student: student
        ? {
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            grade: grade?.name || null,
            gradeId: student.gradeId,
          }
        : null,
      teacher: teacher
        ? {
            id: teacher.id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            name: teacher.displayName || `${teacher.firstName} ${teacher.lastName}`,
          }
        : null,
    };
  });
}

// Map legacy passType to destination
function mapPassTypeToDestination(passType?: string): string {
  switch (passType) {
    case "nurse": return "nurse";
    case "office": return "office";
    case "restroom": return "bathroom";
    case "custom": return "custom";
    case "general":
    default: return "bathroom";
  }
}

// ============================================================================
// Pass CRUD
// ============================================================================

// GET /api/passpilot/passes - List active passes
router.get("/", async (req, res, next) => {
  try {
    // Expire overdue passes first
    await expireOverduePasses(res.locals.schoolId!);

    let rawPasses = await getActivePassesBySchool(res.locals.schoolId!);

    // Teachers only see passes for their assigned grades
    if (
      !req.authUser!.isSuperAdmin &&
      req.session?.role !== "admin" &&
      req.session?.role !== "school_admin"
    ) {
      const assignments = await getTeacherGrades(req.authUser!.id);
      const assignedGradeIds = new Set(assignments.map((a) => a.teacherGrade.gradeId));
      rawPasses = rawPasses.filter(
        (p) => p.gradeId && assignedGradeIds.has(p.gradeId)
      );
    }

    const enriched = await enrichPasses(rawPasses, res.locals.schoolId!);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/active - Alias for active passes
router.get("/active", async (req, res, next) => {
  try {
    await expireOverduePasses(res.locals.schoolId!);
    const rawPasses = await getActivePassesBySchool(res.locals.schoolId!);
    const enriched = await enrichPasses(rawPasses, res.locals.schoolId!);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/history - Pass history with filtering
router.get("/history", async (req, res, next) => {
  try {
    const {
      gradeId,
      studentId,
      teacherId,
      startDate,
      dateStart,
      endDate,
      dateEnd,
      grade: gradeName,
      passType,
    } = req.query as Record<string, string | undefined>;

    // Resolve grade name to gradeId
    let resolvedGradeId = gradeId;
    if (!resolvedGradeId && gradeName) {
      const allGrades = await getGradesBySchool(res.locals.schoolId!);
      const matchedGrade = allGrades.find(
        (g) => g.name.toLowerCase() === gradeName.toLowerCase()
      );
      if (matchedGrade) resolvedGradeId = matchedGrade.id;
    }

    const start = startDate || dateStart;
    const end = endDate || dateEnd;

    let rawPasses = await getPassHistory(res.locals.schoolId!, {
      gradeId: resolvedGradeId,
      studentId,
      teacherId,
      startDate: start ? new Date(start) : undefined,
      endDate: end ? new Date(end) : undefined,
    });

    // In-memory passType filtering (legacy)
    if (passType) {
      rawPasses = rawPasses.filter((p) => {
        switch (passType) {
          case "nurse":
            return p.destination === "nurse";
          case "discipline":
            return p.destination === "office" || p.destination === "counselor";
          case "general":
            return !["nurse", "office", "counselor"].includes(p.destination);
          default:
            return true;
        }
      });
    }

    const enriched = await enrichPasses(rawPasses, res.locals.schoolId!);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/passpilot/passes - Issue a pass
router.post("/", async (req, res, next) => {
  try {
    const body = { ...req.body };

    // Legacy passType → destination mapping
    if (body.passType && !body.destination) {
      body.destination = mapPassTypeToDestination(body.passType);
      if (body.passType === "custom" && body.customReason) {
        body.customDestination = body.customReason;
      }
    }

    const parsed = issuePassSchema.safeParse(body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const { studentId, destination, customDestination, duration, gradeId, notes } =
      parsed.data;

    // Verify student exists in school
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Check for existing active pass
    const activePass = await getActivePassForStudent(studentId, res.locals.schoolId!);
    if (activePass) {
      return res.status(409).json({ error: "Student already has an active pass" });
    }

    // Calculate duration and expiry
    const school = res.locals.school || (await getSchoolById(res.locals.schoolId!));
    const passDuration = duration || school?.defaultPassDuration || 5;
    const expiresAt = new Date(Date.now() + passDuration * 60 * 1000);

    const pass = await createPass({
      schoolId: res.locals.schoolId!,
      studentId,
      teacherId: req.authUser!.id,
      gradeId: gradeId || student.gradeId || null,
      destination,
      customDestination: destination === "custom" ? (customDestination || null) : null,
      status: "active",
      duration: passDuration,
      expiresAt,
      issuedVia: "teacher",
      notes: notes || null,
    });

    return res.status(201).json({ pass });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/return - Return a pass
router.patch("/:id/return", async (req, res, next) => {
  try {
    const pass = await returnPass(param(req, "id"), res.locals.schoolId!);
    if (!pass) {
      return res.status(404).json({ error: "Active pass not found" });
    }
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// PUT /api/passpilot/passes/:id/return - Alias
router.put("/:id/return", async (req, res, next) => {
  try {
    const pass = await returnPass(param(req, "id"), res.locals.schoolId!);
    if (!pass) {
      return res.status(404).json({ error: "Active pass not found" });
    }
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/cancel - Cancel a pass
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const pass = await cancelPass(param(req, "id"), res.locals.schoolId!);
    if (!pass) {
      return res.status(404).json({ error: "Active pass not found" });
    }
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/passpilot/passes/:id - Cancel (alias)
router.delete("/:id", async (req, res, next) => {
  try {
    await cancelPass(param(req, "id"), res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
