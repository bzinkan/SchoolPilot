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
} from "../../services/storage.js";

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

    const student = await getStudentById(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const heartbeats = await getHeartbeatsByStudent(studentId, limit);
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

    const student = await createStudent({
      schoolId: res.locals.schoolId!,
      firstName,
      lastName,
      email: email || null,
      gradeLevel: gradeLevel || null,
      status: "active",
    });

    return res.status(201).json({ student });
  } catch (err) {
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
    const rows = studentData.map((s: any) => ({
      schoolId,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email || null,
      gradeLevel: s.gradeLevel || null,
      status: "active" as const,
    }));

    const created = await bulkCreateStudents(rows);
    return res.json({ created: created.length, students: created });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/students/:studentId - Update student
router.patch("/students/:studentId", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const { firstName, lastName, email, gradeLevel } = req.body;

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
    await deleteStudent(param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/sessions/active/:deviceId - Active session for device
router.get("/sessions/active/:deviceId", ...auth, async (req, res, next) => {
  try {
    const session = await getActiveSessionByStudent(param(req, "deviceId"));
    return res.json({ session: session || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/sessions/all - All active sessions
router.get("/sessions/all", ...auth, async (req, res, next) => {
  try {
    const sessions = await getActiveSessions(res.locals.schoolId!);
    return res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

export default router;
