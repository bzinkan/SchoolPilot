import { Router, type Request } from "express";
import multer from "multer";
import { parse as parseCsv } from "csv-parse/sync";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { createStudentSchema, updateStudentSchema } from "../../schema/validation.js";
import type { InsertStudent } from "../../schema/students.js";
import {
  getRequestGoPilotRole,
  getTeacherHomeroomIds,
  getHomeroomForSchool,
  isGoPilotManager,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
import {
  bulkCreateStudents,
  createStudent,
  deactivateStudentsForRoster,
  getGoPilotStaffStudents,
  getStudentByEmail,
  getStudentById,
  reactivateInactiveStudentForRosterImport,
  updateStudent,
} from "../../services/storage.js";
import {
  checkStudentEmail,
  duplicateEmailError,
  existingEmailSets,
  isEmailChanging,
  isUniqueViolation,
  studentEmailRules,
  studentEmailTaken,
} from "../../services/studentEmailPolicy.js";
import { logAudit } from "../../services/audit.js";
import { stopMailpilotMonitoringForStudent } from "../../services/mailpilotProvisioning.js";
import { revokeClasspilotStudentSocketsAfterRosterRemoval } from "../../realtime/studentSocketRevocation.js";

const router = Router();
const DISMISSAL_TYPES = new Set(["car", "bus", "walker", "afterschool"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const csv = file.mimetype === "text/csv" || /\.csv$/i.test(file.originalname);
    if (!csv) return callback(new Error("Only CSV roster files are supported"));
    return callback(null, true);
  },
});

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;
const staffAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;
const managerAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff"),
] as const;
const lifecycleAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin"),
] as const;

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

function normalizeStudentBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body = { ...raw };
  const aliases: Record<string, string> = {
    first_name: "firstName",
    last_name: "lastName",
    grade: "gradeLevel",
    grade_level: "gradeLevel",
    homeroom_id: "homeroomId",
    dismissal_type: "dismissalType",
    afterschool_reason: "afterschoolReason",
    bus_route: "busRoute",
    student_id_number: "studentIdNumber",
    external_id: "externalId",
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (body[to] === undefined && body[from] !== undefined) body[to] = body[from];
    delete body[from];
  }
  if (body.name && !body.firstName) {
    const parts = String(body.name).trim().split(/\s+/);
    body.firstName = parts.shift() ?? "";
    body.lastName = parts.join(" ");
  }
  delete body.name;
  return body;
}

function normalizeCsvRow(raw: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key.toLowerCase().replace(/[\s_-]+/g, "")] = String(value ?? "").trim();
  }
  let firstName = values.firstname || values.first || "";
  let lastName = values.lastname || values.last || "";
  if (!firstName && !lastName && (values.name || values.fullname)) {
    const fullName = values.name ?? values.fullname ?? "";
    const parts = fullName.split(/\s+/);
    firstName = parts.shift() ?? "";
    lastName = parts.join(" ");
  }
  return {
    firstName,
    lastName,
    email: values.email || "",
    studentIdNumber: values.studentidnumber || values.studentid || values.badgeid || "",
    gradeLevel: values.gradelevel || values.grade || "",
    homeroomId: values.homeroomid || "",
    dismissalType: values.dismissaltype || values.dismissal || "car",
    afterschoolReason: values.afterschoolreason || values.activity || "",
    busRoute: values.busroute || values.bus || values.busnumber || "",
    externalId: values.externalid || values.sisid || "",
  };
}

function cleanOptional(value: unknown): string | null {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

async function validateHomeroom(schoolId: string, homeroomId: unknown): Promise<boolean> {
  const id = cleanOptional(homeroomId);
  return !id || Boolean(await getHomeroomForSchool(id, schoolId));
}

function managerStudentFields(raw: Record<string, unknown>) {
  const normalized = normalizeStudentBody(raw);
  const externalIdProvided = Object.prototype.hasOwnProperty.call(normalized, "externalId");
  const externalId = cleanOptional(normalized.externalId);
  delete normalized.externalId;
  return { normalized, externalId, externalIdProvided };
}

async function rosterStudent(schoolId: string, studentId: string) {
  return (await getGoPilotStaffStudents(schoolId, { includeManagerFields: true }))
    .find((student) => student.id === studentId);
}

function teacherProjection(student: Awaited<ReturnType<typeof getGoPilotStaffStudents>>[number]) {
  const {
    email: _email,
    externalId: _externalId,
    studentIdNumber: _studentIdNumber,
    familyGroupId: _familyGroupId,
    familyName: _familyName,
    carNumber: _carNumber,
    ...safe
  } = student;
  return safe;
}

async function auditRosterMutation(req: Request, schoolId: string, action: string, metadata: Record<string, unknown>) {
  await logAudit({
    schoolId,
    userId: req.authUser?.id ?? null,
    userEmail: req.authUser?.email,
    userRole: String(resolvedRole(req) ?? "staff"),
    action,
    entityType: "student",
    metadata,
  });
}

function resolvedRole(req: Request): string | undefined {
  return (req.res?.locals.gopilotRole as string | undefined) ?? undefined;
}

function mayReactivateStudent(req: Request): boolean {
  const role = resolvedRole(req);
  return Boolean(
    req.authUser?.isSuperAdmin ||
    role === "super_admin" ||
    role === "admin" ||
    role === "school_admin"
  );
}

function reactivationDenied(res: any) {
  return res.status(403).json({
    error: "Only an administrator may restore a removed student.",
    code: "STUDENT_REACTIVATION_FORBIDDEN",
  });
}

// Explicit role-scoped DTO used by all GoPilot roster surfaces.
router.get("/", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const homeroomId = typeof req.query.homeroomId === "string" ? req.query.homeroomId.trim() : undefined;
    const dismissalType = typeof req.query.dismissalType === "string" ? req.query.dismissalType.trim() : undefined;
    if (dismissalType && !DISMISSAL_TYPES.has(dismissalType)) {
      return res.status(400).json({ error: "Invalid dismissalType" });
    }

    const role = await getRequestGoPilotRole(req, res);
    let homeroomIds: string[] | undefined;
    if (!isGoPilotManager(role)) {
      const assigned = await getTeacherHomeroomIds(req.authUser!.id, schoolId);
      if (homeroomId && !assigned.has(homeroomId)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      homeroomIds = [...assigned];
    }

    const rows = await getGoPilotStaffStudents(schoolId, {
      homeroomIds,
      homeroomId,
      dismissalType,
      includeManagerFields: isGoPilotManager(role),
    });
    return res.json({ students: isGoPilotManager(role) ? rows : rows.map(teacherProjection) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/bulk", ...managerAuth, bulkUpdateHandler);
router.put("/bulk-update", ...managerAuth, bulkUpdateHandler);
router.patch("/bulk-update", ...managerAuth, bulkUpdateHandler);

router.get("/:studentId", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const student = await getStudentById(param(req, "studentId"));
    if (!student || student.schoolId !== schoolId || student.status !== "active") {
      return res.status(404).json({ error: "Student not found" });
    }
    const role = await getRequestGoPilotRole(req, res);
    if (!isGoPilotManager(role)) {
      const homeroomIds = await getTeacherHomeroomIds(req.authUser!.id, schoolId);
      if (!student.homeroomId || !homeroomIds.has(student.homeroomId)) {
        return res.status(404).json({ error: "Student not found" });
      }
    }
    const dto = await rosterStudent(schoolId, student.id);
    return res.json({ student: isGoPilotManager(role) ? dto : dto && teacherProjection(dto) });
  } catch (error) {
    return next(error);
  }
});

router.post("/", ...managerAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { normalized, externalId } = managerStudentFields(req.body ?? {});
    const parsed = createStudentSchema.safeParse(normalized);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    if (parsed.data.dismissalType && !DISMISSAL_TYPES.has(parsed.data.dismissalType)) {
      return res.status(400).json({ error: "Invalid dismissalType" });
    }
    if (!(await validateHomeroom(schoolId, parsed.data.homeroomId))) {
      return res.status(400).json({ error: "Homeroom does not belong to this school" });
    }
    const emailError = checkStudentEmail(parsed.data.email, await studentEmailRules(schoolId));
    if (emailError) return res.status(400).json(emailError);
    const emailLc = parsed.data.email?.trim().toLowerCase();
    const existing = emailLc ? await getStudentByEmail(schoolId, emailLc) : undefined;
    if (parsed.data.email) {
      const duplicate = await studentEmailTaken(schoolId, emailLc!, existing?.id);
      if (duplicate) return res.status(409).json({ error: duplicate, code: "STUDENT_EMAIL_TAKEN" });
    }
    const studentData: InsertStudent = {
      schoolId,
      firstName: parsed.data.firstName.trim(),
      lastName: parsed.data.lastName.trim(),
      email: cleanOptional(parsed.data.email),
      studentIdNumber: cleanOptional(parsed.data.studentIdNumber),
      gradeLevel: cleanOptional(parsed.data.gradeLevel),
      homeroomId: cleanOptional(parsed.data.homeroomId),
      dismissalType: parsed.data.dismissalType || "car",
      afterschoolReason: cleanOptional(parsed.data.afterschoolReason),
      busRoute: cleanOptional(parsed.data.busRoute),
      externalId,
      status: "active",
    };
    if (existing) {
      if (existing.status !== "inactive") {
        return res.status(409).json({
          error: "A student with this email already exists in this school.",
          code: "STUDENT_EMAIL_TAKEN",
        });
      }
      if (!mayReactivateStudent(req)) return reactivationDenied(res);
      const restored = await reactivateInactiveStudentForRosterImport(
        schoolId,
        emailLc!,
        studentData,
        {
          userId: req.authUser?.id ?? null,
          userEmail: req.authUser?.email ?? undefined,
          userRole: resolvedRole(req),
          source: "gopilot_roster_add",
        }
      );
      if (!restored.student) {
        return res.status(409).json({ error: "Student roster changed. Try again.", code: "STUDENT_ROSTER_CHANGED" });
      }
      await auditRosterMutation(req, schoolId, "gopilot.student.restored", { studentId: restored.student.id });
      return res.status(201).json({
        student: await rosterStudent(schoolId, restored.student.id),
        restored: restored.reactivated,
      });
    }
    const student = await createStudent(studentData);
    await auditRosterMutation(req, schoolId, "gopilot.student.created", { studentId: student.id });
    return res.status(201).json({ student: await rosterStudent(schoolId, student.id) });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "Duplicate student identifier", code: "STUDENT_DUPLICATE" });
    return next(error);
  }
});

async function updateHandler(req: Request, res: any, next: any) {
  try {
    const schoolId = res.locals.schoolId!;
    const studentId = param(req, "studentId");
    const existing = await getStudentById(studentId);
    if (!existing || existing.schoolId !== schoolId || existing.status !== "active") {
      return res.status(404).json({ error: "Student not found" });
    }
    const { normalized, externalId, externalIdProvided } = managerStudentFields(req.body ?? {});
    delete normalized.status;
    const parsed = updateStudentSchema.safeParse(normalized);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    if (parsed.data.dismissalType && !DISMISSAL_TYPES.has(parsed.data.dismissalType)) {
      return res.status(400).json({ error: "Invalid dismissalType" });
    }
    if (!(await validateHomeroom(schoolId, parsed.data.homeroomId))) {
      return res.status(400).json({ error: "Homeroom does not belong to this school" });
    }
    if (isEmailChanging(parsed.data.email, existing.emailLc)) {
      const emailError = checkStudentEmail(parsed.data.email, await studentEmailRules(schoolId));
      if (emailError) return res.status(400).json(emailError);
      if (parsed.data.email) {
        const duplicate = await studentEmailTaken(schoolId, parsed.data.email.toLowerCase(), studentId);
        if (duplicate) return res.status(409).json({ error: duplicate, code: "STUDENT_EMAIL_TAKEN" });
      }
    }
    const { classpilotPin: _ignored, gradeId: _gradeId, ...allowed } = parsed.data;
    const update: Partial<InsertStudent> = {
      ...allowed,
      ...(externalIdProvided ? { externalId } : {}),
    };
    for (const field of ["email", "studentIdNumber", "gradeLevel", "homeroomId", "afterschoolReason", "busRoute"] as const) {
      if (Object.prototype.hasOwnProperty.call(update, field)) (update as any)[field] = cleanOptional((update as any)[field]);
    }
    if (update.dismissalType && update.dismissalType !== "afterschool") update.afterschoolReason = null;
    if (update.dismissalType && update.dismissalType !== "bus") update.busRoute = null;
    await updateStudent(studentId, update);
    await auditRosterMutation(req, schoolId, "gopilot.student.updated", {
      studentId,
      fields: Object.keys(update).sort(),
    });
    return res.json({ student: await rosterStudent(schoolId, studentId) });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "Duplicate student identifier", code: "STUDENT_DUPLICATE" });
    return next(error);
  }
}

router.patch("/:studentId", ...managerAuth, updateHandler);
router.put("/:studentId", ...managerAuth, updateHandler);

router.delete("/:studentId", ...lifecycleAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const studentId = param(req, "studentId");
    const existing = await getStudentById(studentId);
    if (!existing || existing.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Delegate to the canonical lifecycle transaction so ClassPilot sessions
    // close and the sanitized student.deactivated audit commits atomically.
    // Already-inactive same-school rows remain a successful idempotent retry.
    const result = await deactivateStudentsForRoster(schoolId, [studentId], {
      userId: req.authUser?.id ?? null,
      userEmail: req.authUser?.email ?? null,
      userRole: resolvedRole(req) ?? null,
      source: "gopilot_roster_remove",
    });
    if (!result.foundStudentIds.includes(studentId)) {
      return res.status(404).json({ error: "Student not found" });
    }

    const [socketRevocation, shutdowns] = await Promise.all([
      revokeClasspilotStudentSocketsAfterRosterRemoval(schoolId, result.foundStudentIds),
      Promise.allSettled(
        result.students.map((student) =>
          stopMailpilotMonitoringForStudent(schoolId, student.id, student.email)
        )
      ),
    ]);
    if (!socketRevocation.relayed) {
      console.warn("[GoPilot] Student socket revocation relay unavailable", {
        closedLocalCount: socketRevocation.closedLocal,
      });
    }
    const failedShutdowns = shutdowns.filter((shutdown) => shutdown.status === "rejected").length;
    if (failedShutdowns > 0) {
      console.warn("[GoPilot] Student removal MailPilot shutdown incomplete", {
        failedCount: failedShutdowns,
      });
    }
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

async function bulkUpdateHandler(req: Request, res: any, next: any) {
  try {
    const schoolId = res.locals.schoolId!;
    if (!Array.isArray(req.body?.updates)) return res.status(400).json({ error: "Array of updates required" });
    if (req.body.updates.length > 1_000) return res.status(400).json({ error: "At most 1000 updates are allowed" });
    const students = [];
    const skipped: Array<{ id: string; error: string }> = [];
    for (const raw of req.body.updates) {
      const id = String(raw?.id ?? "");
      if (!id) { skipped.push({ id, error: "Student id is required" }); continue; }
      const existing = await getStudentById(id);
      if (!existing || existing.schoolId !== schoolId || existing.status !== "active") {
        skipped.push({ id, error: "Student not found" });
        continue;
      }
      const { normalized, externalId, externalIdProvided } = managerStudentFields(raw);
      delete normalized.id;
      delete normalized.status;
      const parsed = updateStudentSchema.safeParse(normalized);
      if (!parsed.success || (parsed.data.dismissalType && !DISMISSAL_TYPES.has(parsed.data.dismissalType))) {
        skipped.push({ id, error: parsed.success ? "Invalid dismissalType" : (parsed.error.errors[0]?.message ?? "Invalid input") });
        continue;
      }
      if (!(await validateHomeroom(schoolId, parsed.data.homeroomId))) {
        skipped.push({ id, error: "Homeroom does not belong to this school" });
        continue;
      }
      const { classpilotPin: _pin, gradeId: _grade, ...allowed } = parsed.data;
      const update: Partial<InsertStudent> = {
        ...allowed,
        ...(externalIdProvided ? { externalId } : {}),
      };
      for (const field of ["email", "studentIdNumber", "gradeLevel", "homeroomId", "afterschoolReason", "busRoute"] as const) {
        if (Object.prototype.hasOwnProperty.call(update, field)) (update as any)[field] = cleanOptional((update as any)[field]);
      }
      if (update.dismissalType && update.dismissalType !== "afterschool") update.afterschoolReason = null;
      if (update.dismissalType && update.dismissalType !== "bus") update.busRoute = null;
      try {
        await updateStudent(id, update);
        const dto = await rosterStudent(schoolId, id);
        if (dto) students.push(dto);
      } catch (error) {
        skipped.push({ id, error: isUniqueViolation(error) ? "Duplicate student identifier" : "Update failed" });
      }
    }
    await auditRosterMutation(req, schoolId, "gopilot.student.bulk_updated", {
      requestedCount: req.body.updates.length,
      updatedCount: students.length,
      skippedCount: skipped.length,
    });
    return res.json({ updated: students.length, students, skipped: skipped.length ? skipped : undefined });
  } catch (error) {
    return next(error);
  }
}

async function importHandler(req: Request, res: any, next: any) {
  try {
    const schoolId = res.locals.schoolId!;
    let rawRows: Record<string, unknown>[];
    if (req.file?.buffer) {
      rawRows = parseCsv(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
    } else {
      rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    }
    if (rawRows.length === 0) return res.status(400).json({ error: "CSV file or rows array is required" });
    if (rawRows.length > 5_000) return res.status(400).json({ error: "At most 5000 students may be imported" });

    const rules = await studentEmailRules(schoolId);
    const emailSets = await existingEmailSets(schoolId);
    const batchEmails = new Set<string>();
    const inserts: InsertStudent[] = [];
    const restorations: Array<{ emailLc: string; data: InsertStudent }> = [];
    const errors: Array<{ row: number; error: string }> = [];
    for (let index = 0; index < rawRows.length; index++) {
      const normalized = req.file ? normalizeCsvRow(rawRows[index]!) : normalizeStudentBody(rawRows[index]!);
      const externalId = cleanOptional(normalized.externalId);
      delete normalized.externalId;
      const parsed = createStudentSchema.safeParse(normalized);
      if (!parsed.success || (parsed.data.dismissalType && !DISMISSAL_TYPES.has(parsed.data.dismissalType))) {
        errors.push({ row: index + 1, error: parsed.success ? "Invalid dismissalType" : (parsed.error.errors[0]?.message ?? "Invalid input") });
        continue;
      }
      if (!(await validateHomeroom(schoolId, parsed.data.homeroomId))) {
        errors.push({ row: index + 1, error: "Homeroom does not belong to this school" });
        continue;
      }
      const emailError = checkStudentEmail(parsed.data.email, rules);
      if (emailError) { errors.push({ row: index + 1, error: emailError.error }); continue; }
      const emailLc = parsed.data.email?.trim().toLowerCase();
      if (emailLc) {
        const existing = await getStudentByEmail(schoolId, emailLc);
        if (existing?.status === "inactive" && !mayReactivateStudent(req)) {
          return reactivationDenied(res);
        }
        const duplicate = existing?.status === "inactive"
          ? (emailSets.staff.has(emailLc)
              ? "This email is already used by a staff account; each person needs a unique email."
              : (batchEmails.has(emailLc) ? "Duplicate student email in this import." : null))
          : duplicateEmailError(emailLc, emailSets, batchEmails);
        if (duplicate) { errors.push({ row: index + 1, error: duplicate }); continue; }
        batchEmails.add(emailLc);
        if (existing?.status === "inactive") {
          restorations.push({
            emailLc,
            data: {
              schoolId,
              firstName: parsed.data.firstName.trim(),
              lastName: parsed.data.lastName.trim(),
              email: cleanOptional(parsed.data.email),
              studentIdNumber: cleanOptional(parsed.data.studentIdNumber),
              gradeLevel: cleanOptional(parsed.data.gradeLevel),
              homeroomId: cleanOptional(parsed.data.homeroomId),
              dismissalType: parsed.data.dismissalType || "car",
              afterschoolReason: cleanOptional(parsed.data.afterschoolReason),
              busRoute: cleanOptional(parsed.data.busRoute),
              externalId,
              status: "active",
            },
          });
          continue;
        }
      }
      inserts.push({
        schoolId,
        firstName: parsed.data.firstName.trim(),
        lastName: parsed.data.lastName.trim(),
        email: cleanOptional(parsed.data.email),
        studentIdNumber: cleanOptional(parsed.data.studentIdNumber),
        gradeLevel: cleanOptional(parsed.data.gradeLevel),
        homeroomId: cleanOptional(parsed.data.homeroomId),
        dismissalType: parsed.data.dismissalType || "car",
        afterschoolReason: cleanOptional(parsed.data.afterschoolReason),
        busRoute: cleanOptional(parsed.data.busRoute),
        externalId,
        status: "active",
      });
    }
    let restored = 0;
    for (const candidate of restorations) {
      const result = await reactivateInactiveStudentForRosterImport(
        schoolId,
        candidate.emailLc,
        candidate.data,
        {
          userId: req.authUser?.id ?? null,
          userEmail: req.authUser?.email ?? undefined,
          userRole: resolvedRole(req),
          source: "gopilot_roster_import",
        }
      );
      if (result.reactivated) restored++;
    }
    const created = inserts.length ? await bulkCreateStudents(inserts) : [];
    await auditRosterMutation(req, schoolId, "gopilot.student.imported", {
      requestedCount: rawRows.length,
      importedCount: created.length,
      restoredCount: restored,
      errorCount: errors.length,
    });
    return res.status(201).json({
      imported: created.length,
      restored,
      total: rawRows.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (error) {
    return next(error);
  }
}

router.post("/import", ...managerAuth, upload.single("file"), importHandler);

export default router;
