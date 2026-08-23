import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import {
  searchStudents,
  getStudentsBySchool,
  getStudentById,
  getStudentByEmail,
  getStudentsByExactEmails,
  createStudent,
  updateStudent,
  deactivateStudentsForRoster,
  reactivateInactiveStudentForRosterImport,
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
  existingEmailSets,
  isUniqueViolation,
  studentEmailRules,
  studentEmailTaken,
} from "../../services/studentEmailPolicy.js";
import { logAudit } from "../../services/audit.js";
import type { InsertStudent } from "../../schema/students.js";
import { classPilotStudentDto, classPilotStudentDtos } from "../../util/safeStudent.js";
import {
  encryptClassPilotPin,
  generatedPinForStudent,
  hashClassPilotPin,
  randomFourDigitClassPilotPin,
  type GeneratedClassPilotPin,
} from "../../services/classpilotPins.js";
import { serializeClasspilotSession } from "../../services/classpilotSessionLifecycle.js";
import { stopMailpilotMonitoringForStudent } from "../../services/mailpilotProvisioning.js";
import { revokeClasspilotStudentSocketsAfterRosterRemoval } from "../../realtime/studentSocketRevocation.js";
import {
  ClasspilotStudentDataNotFoundError,
  getClasspilotStudentData,
  parseClasspilotStudentDataPeriod,
} from "../../services/classpilotStudentData.js";
import {
  InvalidRosterCursorError,
  listClasspilotRosterStudentsPage,
} from "../../services/classpilotRosterPagination.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function lifecycleActor(req: any, res: any, source: string) {
  return {
    userId: req.authUser?.id ?? null,
    userEmail: req.authUser?.email ?? null,
    userRole: res.locals.membershipRole ?? null,
    source,
  };
}

function mayManageLifecycle(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

// GET /api/classpilot/students - List all students with optional filters
router.get("/students", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { grade, search } = req.query;
    const filters: Record<string, string> = { status: "active" };
    if (grade) filters.gradeLevel = grade as string;
    if (search) filters.search = search as string;

    const students = await searchStudents(schoolId, filters);
    return res.json({ students: classPilotStudentDtos(students) });
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

// GET /api/classpilot/student-data - One immutable-revision aggregate for the
// Student Data screen and its CSV export. The underlying usage rows are
// heartbeat-derived; screenshots are never read by this contract.
router.get("/student-data", ...adminAuth, async (req, res, next) => {
  try {
    const period = parseClasspilotStudentDataPeriod(req.query.period);
    const sessionId = req.query.sessionId;
    const studentId = req.query.studentId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)) {
      return res.status(400).json({
        error: "sessionId must be a non-empty string",
        code: "INVALID_STUDENT_DATA_SESSION",
      });
    }
    if (studentId !== undefined && (typeof studentId !== "string" || !studentId || studentId.length > 128)) {
      return res.status(400).json({
        error: "studentId must be a non-empty string",
        code: "INVALID_STUDENT_DATA_STUDENT",
      });
    }
    const result = await getClasspilotStudentData({
      schoolId: res.locals.schoolId!,
      period,
      sessionId,
      studentId,
      schoolTimeZone: res.locals.school?.schoolTimezone,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json(result);
  } catch (err) {
    if (err instanceof ClasspilotStudentDataNotFoundError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    if ((err as { code?: string })?.code === "INVALID_STUDENT_DATA_PERIOD") {
      return res.status(400).json({
        error: (err as Error).message,
        code: "INVALID_STUDENT_DATA_PERIOD",
      });
    }
    next(err);
  }
});

// GET /api/classpilot/student-analytics/:studentId - Student activity analytics
router.get("/student-analytics/:studentId", ...adminAuth, async (req, res, next) => {
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

    return res.json({
      student: classPilotStudentDto(student),
      heartbeats: heartbeats.map((heartbeat) => ({
        timestamp: heartbeat.timestamp,
        activeTabUrl: heartbeat.activeTabUrl,
        activeTabTitle: heartbeat.activeTabTitle,
        favicon: heartbeat.favicon,
        screenLocked: heartbeat.screenLocked,
        flightPathActive: heartbeat.flightPathActive,
        activeFlightPathName: heartbeat.activeFlightPathName,
        isSharing: heartbeat.isSharing,
        cameraActive: heartbeat.cameraActive,
        aiCategory: heartbeat.aiCategory,
        safetyAlert: heartbeat.safetyAlert,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/student-analytics/:studentId/usage - Daily usage history
router.get("/student-analytics/:studentId/usage", ...adminAuth, async (req, res, next) => {
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
    const paged = ["cursor", "limit", "search"].some((key) => (
      Object.prototype.hasOwnProperty.call(req.query, key)
    ));
    if (paged) {
      const page = await listClasspilotRosterStudentsPage({
        schoolId: res.locals.schoolId!,
        cursor: req.query.cursor as string | undefined,
        limit: req.query.limit as string | undefined,
        search: req.query.search as string | undefined,
      });
      return res.json({
        students: classPilotStudentDtos(page.students),
        pageInfo: {
          limit: page.limit,
          hasNextPage: page.hasMore,
          nextCursor: page.nextCursor,
        },
        // Flat aliases make the additive response straightforward for clients
        // already using `{ students, hasMore, nextCursor }` conventions.
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    }
    const students = await getStudentsBySchool(res.locals.schoolId!);
    return res.json({ students: classPilotStudentDtos(students) });
  } catch (err) {
    if (err instanceof InvalidRosterCursorError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// GET /api/classpilot/roster/devices - List all devices
router.get("/roster/devices", ...adminAuth, async (req, res, next) => {
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
      const emailLc = normalizedEmail.toLowerCase();
      const existing = await getStudentByEmail(schoolId, emailLc);
      if (existing && existing.status !== "active" && mayManageLifecycle(req, res)) {
        const restored = await reactivateInactiveStudentForRosterImport(
          schoolId,
          emailLc,
          {
            firstName,
            lastName,
            email: normalizedEmail,
            gradeLevel: gradeLevel || null,
          },
          lifecycleActor(req, res, "classpilot.roster.student")
        );
        if (restored.student) {
          return res.status(201).json({
            student: classPilotStudentDto(restored.student),
            generatedPins: [],
            restored: restored.reactivated,
          });
        }
      }
      const taken = await studentEmailTaken(schoolId, emailLc);
      if (taken) {
        return res.status(409).json({ error: taken, code: "STUDENT_EMAIL_TAKEN" });
      }
    }

    const pin = randomFourDigitClassPilotPin();
    const student = await createStudent({
      schoolId,
      firstName,
      lastName,
      email: normalizedEmail || null,
      gradeLevel: gradeLevel || null,
      classpilotPinHash: await hashClassPilotPin(pin),
      classpilotPinEncrypted: encryptClassPilotPin(pin),
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

    return res.status(201).json({
      student: classPilotStudentDto(student),
      generatedPins: [generatedPinForStudent(student, pin)],
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

// POST /api/classpilot/roster/bulk - Bulk import students
router.post("/roster/bulk", ...auth, requireRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const { students: studentData } = req.body;
    if (!Array.isArray(studentData) || studentData.length === 0) {
      return res.status(400).json({ error: "students array required" });
    }

    const schoolId = res.locals.schoolId!;
    const rows: InsertStudent[] = [];
    const toRestore: Array<{ emailLc: string; data: InsertStudent }> = [];
    const errors: { index: number; error: string }[] = [];
    const rules = await studentEmailRules(schoolId);
    const emailSets = await existingEmailSets(schoolId);
    const existingStudents = await getStudentsByExactEmails(
      schoolId,
      studentData.flatMap((student: Record<string, unknown>) => {
        const email = typeof student?.email === "string" ? student.email.trim().toLowerCase() : "";
        return email ? [email] : [];
      })
    );
    const existingByEmail = new Map(
      existingStudents.flatMap((student) => student.emailLc ? [[student.emailLc, student] as const] : [])
    );
    const batchEmails = new Set<string>();
    const usedPins = new Set<string>();
    const plaintextPins: string[] = [];

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
      let existing: (typeof existingStudents)[number] | undefined;
      if (normalizedEmail) {
        const emailLc = normalizedEmail.toLowerCase();
        if (emailSets.staff.has(emailLc)) {
          errors.push({
            index: i,
            error: "This email is already used by a staff account; each person needs a unique email.",
          });
          continue;
        }
        if (batchEmails.has(emailLc)) {
          errors.push({ index: i, error: "Duplicate student email in this import." });
          continue;
        }
        existing = existingByEmail.get(emailLc);
        if (existing?.status === "active") {
          errors.push({
            index: i,
            error: "Duplicate student email; this address is already in use in this school.",
          });
          continue;
        }
        batchEmails.add(emailLc);
      }
      const data: InsertStudent = {
        schoolId,
        firstName: s.firstName,
        lastName: s.lastName,
        email: normalizedEmail || null,
        gradeLevel: s.gradeLevel || null,
        status: "active" as const,
      };
      if (existing && existing.status !== "active" && normalizedEmail) {
        toRestore.push({
          emailLc: normalizedEmail.toLowerCase(),
          data,
        });
      } else {
        const pin = randomFourDigitClassPilotPin(usedPins);
        plaintextPins.push(pin);
        rows.push({
          ...data,
          classpilotPinHash: await hashClassPilotPin(pin),
          classpilotPinEncrypted: encryptClassPilotPin(pin),
        });
      }
    }

    const restoredStudents = [];
    let restoredCount = 0;
    for (const candidate of toRestore) {
      const restored = await reactivateInactiveStudentForRosterImport(
        schoolId,
        candidate.emailLc,
        candidate.data,
        lifecycleActor(req, res, "classpilot.roster.bulk")
      );
      if (restored.student) {
        restoredStudents.push(restored.student);
        if (restored.reactivated) restoredCount++;
      }
    }

    const created = await bulkCreateStudents(rows);
    const generatedPins: GeneratedClassPilotPin[] = created.map((student, index) =>
      generatedPinForStudent(student, plaintextPins[index]!)
    );
    return res.json({
      created: created.length + restoredStudents.length,
      restored: restoredCount,
      students: classPilotStudentDtos([...restoredStudents, ...created]),
      errors: errors.length > 0 ? errors : undefined,
      total: studentData.length,
      generatedPins,
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
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "status")) {
      return res.status(400).json({
        error: "Student status is managed through the Remove Student workflow.",
        code: "STUDENT_STATUS_MANAGED_SEPARATELY",
      });
    }
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
    return res.json({ student: updated ? classPilotStudentDto(updated) : updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/students/:studentId - Delete student
router.delete("/students/:studentId", ...auth, requireRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");

    // School-isolation: verify ownership before delete.
    const existing = await getStudentById(studentId);
    if (!existing || existing.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    const result = await deactivateStudentsForRoster(
      res.locals.schoolId!,
      [studentId],
      lifecycleActor(req, res, "classpilot.students.delete")
    );
    try {
      await revokeClasspilotStudentSocketsAfterRosterRemoval(
        res.locals.schoolId!,
        result.foundStudentIds
      );
    } catch {
      console.warn("[Student Removal] ClassPilot socket shutdown failed after deactivation", {
        studentCount: result.foundStudentIds.length,
      });
    }
    if (result.deactivatedStudentIds.length > 0) {
      try {
        await stopMailpilotMonitoringForStudent(
          res.locals.schoolId!,
          existing.id,
          existing.email
        );
      } catch {
        console.warn("[Student Removal] MailPilot shutdown failed after deactivation");
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/sessions/active/:deviceId - Active session for a student
// (param is a studentId; historically mislabeled "deviceId")
router.get("/sessions/active/:deviceId", ...adminAuth, async (req, res, next) => {
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
router.get("/sessions/all", ...auth, requireRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const sessions = await getActiveTeachingSessions(res.locals.schoolId!);
    return res.json({ sessions: sessions.map(serializeClasspilotSession) });
  } catch (err) {
    next(err);
  }
});

export default router;
