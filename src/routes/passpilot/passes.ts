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
  createPass,
  returnPass,
  cancelPass,
  expireOverduePasses,
  getStudentById,
  getStudentsBySchool,
  getUserById,
  getGradesBySchool,
  getSchoolById,
  getSettingsForSchool,
  getAbsentStudentIds,
  createStudentTimelineEvent,
} from "../../services/storage.js";
import { isWithinTrackingWindow } from "../../services/schoolHours.js";
import type { Pass } from "../../schema/passpilot.js";
import {
  canAccessGrade,
  canAccessPass,
  canAccessStudent,
  filterPassesForRole,
  getGradeForSchool,
  getPassForSchool,
  getRequestPassPilotRole,
  isPassPilotManager,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

// All pass routes require auth + school context + active school + PassPilot license
router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher")
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

function recordPassTimeline(pass: Pass, action: "issued" | "returned" | "cancelled", actorUserId: string) {
  return createStudentTimelineEvent({
    schoolId: pass.schoolId,
    studentId: pass.studentId,
    eventType: "pass",
    sourceType: "passpilot",
    sourceId: pass.id,
    title: `Hall pass ${action}: ${pass.destination}`,
    summary: pass.customDestination || pass.notes || null,
    actorUserId,
    metadata: {
      status: pass.status,
      destination: pass.destination,
      customDestination: pass.customDestination,
      issuedAt: pass.issuedAt,
      returnedAt: pass.returnedAt,
      expiresAt: pass.expiresAt,
    },
  });
}

// ============================================================================
// Pass CRUD
// ============================================================================

// GET /api/passpilot/passes - List active passes
router.get("/", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);

    // Expire overdue passes first
    await expireOverduePasses(schoolId);

    const rawPasses = await getActivePassesBySchool(schoolId);
    const scopedPasses = await filterPassesForRole(rawPasses, req.authUser!, schoolId, role);
    const enriched = await enrichPasses(scopedPasses, schoolId);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/active - Alias for active passes
router.get("/active", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    await expireOverduePasses(schoolId);
    const rawPasses = await getActivePassesBySchool(schoolId);
    const scopedPasses = await filterPassesForRole(rawPasses, req.authUser!, schoolId, role);
    const enriched = await enrichPasses(scopedPasses, schoolId);
    return res.json({ passes: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/passpilot/passes/history - Pass history with filtering
router.get("/history", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
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

    if (resolvedGradeId && !(await canAccessGrade(req.authUser!, schoolId, resolvedGradeId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (studentId && !(await canAccessStudent(req.authUser!, schoolId, studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (teacherId && !isPassPilotManager(role) && teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const start = startDate || dateStart;
    const end = endDate || dateEnd;

    let rawPasses = await getPassHistory(schoolId, {
      gradeId: resolvedGradeId,
      studentId,
      teacherId: isPassPilotManager(role) ? teacherId : undefined,
      startDate: start ? new Date(start) : undefined,
      endDate: end ? new Date(end) : undefined,
    });
    rawPasses = await filterPassesForRole(rawPasses, req.authUser!, schoolId, role);

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

    const enriched = await enrichPasses(rawPasses, schoolId);
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
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);

    // Verify student exists in school
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(400).json({ error: "Student not found" });
    }
    if (!(await canAccessStudent(req.authUser!, schoolId, studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    let passGradeId = student.gradeId || null;
    if (gradeId) {
      const grade = await getGradeForSchool(gradeId, schoolId);
      if (!grade) {
        return res.status(400).json({ error: "Class not found" });
      }
      if (student.gradeId && gradeId !== student.gradeId) {
        return res.status(400).json({ error: "Class does not match student" });
      }
      if (!(await canAccessGrade(req.authUser!, schoolId, gradeId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      passGradeId = gradeId;
    }

    // Check if student is absent
    const today = new Date().toISOString().slice(0, 10);
    const absentIds = await getAbsentStudentIds(schoolId, today);
    if (absentIds.has(studentId)) {
      return res.status(400).json({ error: "Cannot issue pass to absent student" });
    }

    // Expire any overdue passes FIRST, so a pass that already lapsed doesn't
    // block issuing a new one (otherwise a stale "active" pass returns 409).
    await expireOverduePasses(schoolId);

    // Check for existing active pass
    const activePass = await getActivePassForStudent(studentId, schoolId);
    if (activePass) {
      return res.status(409).json({ error: "Student already has an active pass" });
    }

    // Enforce school hours
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return res.status(403).json({ error: "Passes cannot be issued outside school hours" });
    }

    // Calculate duration and expiry
    const school = res.locals.school || (await getSchoolById(schoolId));
    const passDuration = duration || school?.defaultPassDuration || 5;
    const expiresAt = new Date(Date.now() + passDuration * 60 * 1000);

    let pass;
    try {
      pass = await createPass({
        schoolId,
        studentId,
        teacherId: req.authUser!.id,
        gradeId: passGradeId,
        destination,
        customDestination: destination === "custom" ? (customDestination || null) : null,
        status: "active",
        duration: passDuration,
        expiresAt,
        issuedVia: "teacher",
        notes: notes || null,
      });
    } catch (err: any) {
      // Partial unique index (one active pass per student) — a concurrent
      // double-issue loses the race here. Surface it as the same 409.
      if (err?.code === "23505") {
        return res.status(409).json({ error: "Student already has an active pass" });
      }
      throw err;
    }

    await recordPassTimeline(pass, "issued", req.authUser!.id);
    return res.status(201).json({ pass });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/return - Return a pass
router.patch("/:id/return", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await returnPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "returned", req.authUser!.id);
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// PUT /api/passpilot/passes/:id/return - Alias
router.put("/:id/return", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await returnPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "returned", req.authUser!.id);
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/passpilot/passes/:id/cancel - Cancel a pass
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }

    const pass = await cancelPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "cancelled", req.authUser!.id);
    return res.json({ pass });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/passpilot/passes/:id - Cancel (alias)
router.delete("/:id", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const id = param(req, "id");
    const role = await getRequestPassPilotRole(req, res);
    const existing = await getPassForSchool(id, schoolId);
    if (!existing || !(await canAccessPass(req.authUser!, schoolId, existing, role))) {
      return res.status(404).json({ error: "Active pass not found" });
    }
    const pass = await cancelPass(id, schoolId);
    if (!pass) {
      return res.status(400).json({ error: "Active pass not found" });
    }
    await recordPassTimeline(pass, "cancelled", req.authUser!.id);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
