import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  searchStudents,
  getStudentsBySchool,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  bulkCreateStudents,
  getHeartbeatsByStudent,
  getDevicesBySchool,
  getActiveSessionByStudent,
  getActiveSessions,
  getActiveTeachingSessions,
  getDailyUsageForStudent,
} from "../../services/storage.js";
import {
  checkStudentEmail,
  duplicateEmailError,
  existingEmailSets,
  isUniqueViolation,
  studentEmailRules,
  studentEmailTaken,
} from "../../services/studentEmailPolicy.js";
import { logAudit } from "../../services/audit.js";
import type { InsertStudent } from "../../schema/students.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// GET /api/classpilot/students - List all students with optional filters
router.get("/students", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { status, grade, search } = req.query;
    const filters: Record<string, string> = {};
    if (status) filters.status = status as string;
    if (grade) filters.gradeLevel = grade as string;
    if (search) filters.search = search as string;

    const students = await searchStudents(schoolId, filters);
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/student-analytics - Summary analytics for all students
router.get("/student-analytics", ...auth, async (req, res, next) => {
  try {
    const students = await getStudentsBySchool(res.locals.schoolId!);
    return res.json({ analytics: students.map((s) => ({ studentId: s.id, name: `${s.firstName} ${s.lastName}` })) });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/student-analytics/:studentId - Student activity analytics
router.get("/student-analytics/:studentId", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const limit = parseInt(req.query.limit as string) || 100;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    if (startDate && isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid startDate" });
    if (endDate && isNaN(endDate.getTime())) return res.status(400).json({ error: "Invalid endDate" });

    // School-isolation: a student id from another school must 404, never leak
    // that school's monitoring data (heartbeats = screen activity, URLs, alerts).
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const heartbeats = await getHeartbeatsByStudent(studentId, limit, startDate, endDate);
    const activeSession = await getActiveSessionByStudent(studentId);

    return res.json({
      student,
      heartbeats,
      activeSession,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/student-analytics/:studentId/usage - Daily usage history
router.get("/student-analytics/:studentId/usage", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");

    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Default: last 7 days
    const now = new Date();
    const defaultStart = new Date(now);
    defaultStart.setDate(defaultStart.getDate() - 7);

    const startDate = (req.query.startDate as string) || defaultStart.toISOString().slice(0, 10);
    const endDate = (req.query.endDate as string) || now.toISOString().slice(0, 10);

    const usage = await getDailyUsageForStudent(studentId, startDate, endDate);
    return res.json({ usage });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/roster/students - List roster students
router.get("/roster/students", ...auth, async (req, res, next) => {
  try {
    const students = await getStudentsBySchool(res.locals.schoolId!);
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/roster/devices - List all devices
router.get("/roster/devices", ...auth, async (req, res, next) => {
  try {
    const devices = await getDevicesBySchool(res.locals.schoolId!);
    return res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/roster/student - Add student to roster
router.post("/roster/student", ...auth, async (req, res, next) => {
  try {
    const { firstName, lastName, email, gradeLevel } = req.body;
    if (!firstName || !lastName) {
      return res.status(400).json({ error: "firstName and lastName required" });
    }
    const schoolId = res.locals.schoolId!;
    const normalizedEmail = typeof email === "string" ? email.trim() : "";
    const emailErr = checkStudentEmail(
      normalizedEmail || null,
      await studentEmailRules(schoolId)
    );
    if (emailErr) {
      return res.status(400).json({
        error: emailErr.error,
        code: emailErr.code,
        expectedDomain: emailErr.expectedDomain,
        actualDomain: emailErr.actualDomain,
      });
    }
    if (normalizedEmail) {
      const taken = await studentEmailTaken(schoolId, normalizedEmail.toLowerCase());
      if (taken) {
        return res.status(409).json({ error: taken, code: "STUDENT_EMAIL_TAKEN" });
      }
    }

    const student = await createStudent({
      schoolId,
      firstName,
      lastName,
      email: normalizedEmail || null,
      gradeLevel: gradeLevel || null,
      status: "active",
    });

    logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "student.create",
      entityType: "student",
      entityId: student.id,
      entityName: `${firstName} ${lastName}`,
    });

    return res.status(201).json({ student });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: "A student with this email, badge ID, or code already exists in this school.",
        code: "STUDENT_DUPLICATE",
      });
    }
    next(err);
  }
});

// POST /api/classpilot/roster/bulk - Bulk import students
router.post("/roster/bulk", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const { students: studentData } = req.body;
    if (!Array.isArray(studentData) || studentData.length === 0) {
      return res.status(400).json({ error: "students array required" });
    }

    const schoolId = res.locals.schoolId!;
    const rows: InsertStudent[] = [];
    const errors: { index: number; error: string }[] = [];
    const rules = await studentEmailRules(schoolId);
    const emailSets = await existingEmailSets(schoolId);
    const batchEmails = new Set<string>();

    for (let i = 0; i < studentData.length; i++) {
      const s = studentData[i];
      if (!s?.firstName || !s?.lastName) {
        errors.push({ index: i, error: "firstName and lastName required" });
        continue;
      }
      const normalizedEmail = typeof s.email === "string" ? s.email.trim() : "";
      const emailErr = checkStudentEmail(normalizedEmail || null, rules);
      if (emailErr) {
        errors.push({ index: i, error: emailErr.error });
        continue;
      }
      if (normalizedEmail) {
        const emailLc = normalizedEmail.toLowerCase();
        const dupErr = duplicateEmailError(emailLc, emailSets, batchEmails);
        if (dupErr) {
          errors.push({ index: i, error: dupErr });
          continue;
        }
        batchEmails.add(emailLc);
      }
      rows.push({
        schoolId,
        firstName: s.firstName,
        lastName: s.lastName,
        email: normalizedEmail || null,
        gradeLevel: s.gradeLevel || null,
        status: "active" as const,
      });
    }

    const created = await bulkCreateStudents(rows);
    return res.json({
      created: created.length,
      students: created,
      errors: errors.length > 0 ? errors : undefined,
      total: studentData.length,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({
        error: "A student with this email, badge ID, or code already exists in this school.",
        code: "STUDENT_DUPLICATE",
      });
    }
    next(err);
  }
});

// PATCH /api/classpilot/students/:studentId - Update student
router.patch("/students/:studentId", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const { firstName, lastName, email, gradeLevel } = req.body;

    // School-isolation: verify the student belongs to this school before edit.
    const existing = await getStudentById(studentId);
    if (!existing || existing.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const data: Record<string, unknown> = {};
    if (firstName !== undefined) data.firstName = firstName;
    if (lastName !== undefined) data.lastName = lastName;
    if (email !== undefined) data.email = email;
    if (gradeLevel !== undefined) data.gradeLevel = gradeLevel;

    const updated = await updateStudent(studentId, data);
    if (!updated) {
      return res.status(404).json({ error: "Student not found" });
    }
    return res.json({ student: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/students/:studentId - Delete student
router.delete("/students/:studentId", ...auth, requireRole("admin"), async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");

    // School-isolation: verify ownership before delete.
    const existing = await getStudentById(studentId);
    if (!existing || existing.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    await deleteStudent(studentId);

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "student.delete",
      entityType: "student",
      entityId: studentId,
      entityName: `${existing.firstName} ${existing.lastName}`,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/sessions/active/:deviceId - Active session for a student
// (param is a studentId; historically mislabeled "deviceId")
router.get("/sessions/active/:deviceId", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "deviceId");
    // School-isolation: only return the session if the student belongs to
    // this school; never leak another school's session state.
    const student = await getStudentById(id);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.json({ session: null });
    }
    const session = await getActiveSessionByStudent(id);
    return res.json({ session: session || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/sessions/all - All active teaching sessions (for admin observe)
router.get("/sessions/all", ...auth, async (req, res, next) => {
  try {
    const sessions = await getActiveTeachingSessions(res.locals.schoolId!);
    return res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

export default router;
