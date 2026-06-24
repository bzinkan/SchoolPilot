import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getAbsentStudentIds,
  getAttendanceBySchool,
  getAttendanceRecordById,
  getStudentAttendance,
  markStudentsAbsentBulk,
  removeAbsence,
  getAttendanceStats,
  getUserById,
  getStudentById,
  getStudentsBySchool,
  getSchoolById,
  createStudentTimelineEvent,
} from "../../services/storage.js";
import {
  getRequestGoPilotRole,
  getTeacherHomeroomIds,
  hasActiveGoPilotLicense,
  isGoPilotManager,
} from "../../services/gopilotAccess.js";

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

/** Return today's date string in a given IANA timezone (defaults to America/New_York). */
function todayInTz(tz = "America/New_York"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function todayForSchool(schoolId: string): Promise<string> {
  const school = await getSchoolById(schoolId);
  return todayInTz(school?.schoolTimezone || "America/New_York");
}

type AttendanceScope =
  | { kind: "all" }
  | { kind: "homerooms"; homeroomIds: Set<string> };

async function getAttendanceScope(req: any, res: any): Promise<AttendanceScope | null> {
  const schoolId = res.locals.schoolId!;
  if (req.authUser?.isSuperAdmin || !(await hasActiveGoPilotLicense(schoolId))) {
    return { kind: "all" };
  }

  const role = await getRequestGoPilotRole(req, res);
  if (isGoPilotManager(role)) return { kind: "all" };
  if (role === "teacher") {
    return {
      kind: "homerooms",
      homeroomIds: await getTeacherHomeroomIds(req.authUser!.id, schoolId),
    };
  }

  return null;
}

function studentInAttendanceScope(
  student: { homeroomId?: string | null },
  scope: AttendanceScope
): boolean {
  return scope.kind === "all" || (!!student.homeroomId && scope.homeroomIds.has(student.homeroomId));
}

// GET /api/admin/attendance?date=YYYY-MM-DD — list attendance for a date
router.get("/", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const date = (req.query.date as string) || await todayForSchool(schoolId);
    const scope = await getAttendanceScope(req, res);
    if (!scope) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const records = (await getAttendanceBySchool(schoolId, date))
      .filter((r) => studentInAttendanceScope(r.student, scope));

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

    const schoolId = res.locals.schoolId!;
    const attendanceDate = date || await todayForSchool(schoolId);
    const scope = await getAttendanceScope(req, res);
    if (!scope) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Verify all students belong to this school
    const schoolStudents = await getStudentsBySchool(schoolId);
    const schoolStudentIds = new Set(schoolStudents.map((s) => s.id));
    const invalid = ids.filter((id: string) => !schoolStudentIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Students not found in this school: ${invalid.join(", ")}`,
      });
    }
    const studentById = new Map(schoolStudents.map((student) => [student.id, student]));
    const outOfScope = ids.filter((id) => {
      const student = studentById.get(id);
      return !student || !studentInAttendanceScope(student, scope);
    });
    if (outOfScope.length > 0) {
      return res.status(403).json({ error: "Teachers can only mark attendance for assigned homerooms" });
    }

    const records = await markStudentsAbsentBulk(schoolId, ids, {
      date: attendanceDate,
      status,
      reason: reason || null,
      notes: notes || null,
      markedBy: req.authUser!.id,
    });

    await Promise.all(records.map((record) => createStudentTimelineEvent({
      schoolId,
      studentId: record.studentId,
      eventType: "attendance",
      sourceType: "attendance",
      sourceId: record.id,
      title: `Attendance marked ${record.status}`,
      summary: record.reason || record.notes || null,
      actorUserId: req.authUser!.id,
      metadata: {
        date: record.date,
        status: record.status,
        source: record.source,
      },
    })));

    return res.status(201).json({ records, count: records.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/attendance/:id — remove an absence record
router.delete("/:id", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const scope = await getAttendanceScope(req, res);
    if (!scope) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const record = await getAttendanceRecordById(param(req, "id"), schoolId);
    if (!record) {
      return res.status(404).json({ error: "Attendance record not found" });
    }
    const student = await getStudentById(record.studentId);
    if (!student || student.schoolId !== schoolId || !studentInAttendanceScope(student, scope)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const removed = await removeAbsence(param(req, "id"), schoolId);
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
      const schoolId = res.locals.schoolId!;
      // Verify the student belongs to the caller's school before returning history.
      const student = await getStudentById(studentId);
      if (!student || student.schoolId !== schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }
      const scope = await getAttendanceScope(req, res);
      if (!scope || !studentInAttendanceScope(student, scope)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const start = (req.query.start as string) || "2020-01-01";
      const end = (req.query.end as string) || await todayForSchool(schoolId);
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
    const schoolToday = await todayForSchool(schoolId);
    const start = (req.query.start as string) || schoolToday;
    const end = (req.query.end as string) || schoolToday;
    const stats = await getAttendanceStats(schoolId, start, end);
    return res.json({ stats });
  } catch (err) {
    next(err);
  }
});

export default router;
