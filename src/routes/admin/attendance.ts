import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getAbsentStudentIds,
  getAttendanceBySchool,
  getStudentAttendance,
  markStudentAbsent,
  markStudentsAbsentBulk,
  removeAbsence,
  getAttendanceStats,
  getUserById,
} from "../../services/storage.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

const schoolAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
] as const;

const staffAuth = [
  ...schoolAuth,
  requireRole("admin", "teacher", "office_staff"),
] as const;

const adminAuth = [...schoolAuth, requireRole("admin")] as const;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/admin/attendance?date=YYYY-MM-DD — list attendance for a date
router.get("/", ...staffAuth, async (req, res, next) => {
  try {
    const date = (req.query.date as string) || todayDate();
    const schoolId = res.locals.schoolId!;
    const records = await getAttendanceBySchool(schoolId, date);

    // Enrich with who marked it
    const markerIds = [
      ...new Set(records.map((r) => r.attendance.markedBy)),
    ];
    const markerMap = new Map<string, string>();
    for (const mid of markerIds) {
      const user = await getUserById(mid);
      if (user) {
        markerMap.set(
          mid,
          user.displayName || `${user.firstName} ${user.lastName}`
        );
      }
    }

    return res.json({
      date,
      records: records.map((r) => ({
        id: r.attendance.id,
        studentId: r.attendance.studentId,
        date: r.attendance.date,
        status: r.attendance.status,
        reason: r.attendance.reason,
        notes: r.attendance.notes,
        markedBy: r.attendance.markedBy,
        markedByName: markerMap.get(r.attendance.markedBy) || "Unknown",
        source: r.attendance.source,
        createdAt: r.attendance.createdAt,
        student: {
          id: r.student.id,
          firstName: r.student.firstName,
          lastName: r.student.lastName,
          name: `${r.student.firstName} ${r.student.lastName}`,
          gradeLevel: r.student.gradeLevel,
          gradeId: r.student.gradeId,
          homeroomId: r.student.homeroomId,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/attendance — mark student(s) absent
router.post("/", ...staffAuth, async (req, res, next) => {
  try {
    const {
      studentIds,
      studentId,
      date,
      status = "absent",
      reason,
      notes,
    } = req.body;

    const ids: string[] = studentIds || (studentId ? [studentId] : []);
    if (ids.length === 0) {
      return res
        .status(400)
        .json({ error: "studentIds or studentId is required" });
    }

    const validStatuses = ["absent", "tardy", "early_dismissal"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const attendanceDate = date || todayDate();
    const schoolId = res.locals.schoolId!;

    const records = await markStudentsAbsentBulk(schoolId, ids, {
      date: attendanceDate,
      status,
      reason: reason || null,
      notes: notes || null,
      markedBy: req.authUser!.id,
    });

    return res.status(201).json({ records, count: records.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/attendance/:id — remove an absence record
router.delete("/:id", ...staffAuth, async (req, res, next) => {
  try {
    const removed = await removeAbsence(param(req, "id"));
    if (!removed) {
      return res.status(404).json({ error: "Attendance record not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/attendance/student/:studentId — history for one student
router.get(
  "/student/:studentId",
  ...staffAuth,
  async (req, res, next) => {
    try {
      const studentId = param(req, "studentId");
      const start = (req.query.start as string) || "2020-01-01";
      const end = (req.query.end as string) || todayDate();
      const records = await getStudentAttendance(studentId, start, end);
      return res.json({ records });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/admin/attendance/stats — attendance stats for reporting
router.get("/stats", ...adminAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const start = (req.query.start as string) || todayDate();
    const end = (req.query.end as string) || todayDate();
    const stats = await getAttendanceStats(schoolId, start, end);
    return res.json({ stats });
  } catch (err) {
    next(err);
  }
});

export default router;
