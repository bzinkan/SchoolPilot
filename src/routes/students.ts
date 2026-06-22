import { Router, type Request, type Response } from "express";
import { randomInt } from "crypto";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireRole } from "../middleware/requireRole.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../middleware/requireProductLicense.js";
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
  getStudentsBySchool,
  bulkCreateStudents,
  getProductLicenses,
  autoAssignFamilyGroups,
} from "../services/storage.js";
import {
  checkStudentEmail,
  duplicateEmailError,
  existingEmailSets,
  isEmailChanging,
  isUniqueViolation,
  studentEmailRules,
  studentEmailTaken,
} from "../services/studentEmailPolicy.js";
import type { InsertStudent, Student } from "../schema/students.js";
import db from "../db.js";
import { and, eq, inArray } from "drizzle-orm";
import { familyGroups, familyGroupStudents } from "../schema/gopilot.js";
import { homerooms } from "../schema/gopilot.js";
import {
  getRequestGoPilotRole,
  getTeacherHomeroomIds,
  hasActiveGoPilotLicense,
} from "../services/gopilotAccess.js";
import { hashPassword } from "../util/password.js";
import { students as studentsTable } from "../schema/students.js";

const router = Router();
const CLASSPILOT_PIN_HASH_CONCURRENCY = 4;

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

router.use(authenticate);

const schoolContext = [requireSchoolContext, requireActiveSchool, requireProductLicense("CLASSPILOT", "PASSPILOT", "GOPILOT")] as const;

type StudentSearchOptions = Parameters<typeof searchStudents>[1];

function stripStudentCredentialHash<T extends { classpilotPinHash?: string | null }>(
  student: T
): Omit<T, "classpilotPinHash"> {
  const { classpilotPinHash: _classpilotPinHash, ...safeStudent } = student;
  return safeStudent;
}

function randomFourDigitPin(usedPins?: Set<string>): string {
  if (usedPins && usedPins.size >= 10000) {
    throw new Error("No unique PINs available");
  }
  let pin = "";
  do {
    pin = String(randomInt(0, 10000)).padStart(4, "0");
  } while (usedPins?.has(pin));
  usedPins?.add(pin);
  return pin;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function prepareStudentUpdateData(data: Record<string, unknown>): Partial<InsertStudent> {
  const updateData = { ...data } as Partial<InsertStudent> & Record<string, unknown>;
  delete updateData.id;
  delete updateData.schoolId;

  if (updateData.email !== undefined) {
    const email = typeof updateData.email === "string" ? updateData.email.trim() : updateData.email;
    updateData.email = email;
    updateData.emailLc = email ? String(email).toLowerCase() : null;
  }

  return updateData;
}

function normalizeGradeLevel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/^grade\s+/i, "").replace(/(\d+)(st|nd|rd|th)$/i, "$1");
  if (/^(k|kg|kindergarten)$/i.test(normalized)) return "K";
  return normalized;
}

async function classpilotPinHashFromInput(
  classpilotPin: string | null | undefined
): Promise<{ classpilotPinHash?: string | null }> {
  if (classpilotPin === undefined) return {};
  if (classpilotPin === null || classpilotPin === "") {
    return { classpilotPinHash: null };
  }
  return { classpilotPinHash: await hashPassword(classpilotPin) };
}

async function searchStudentsVisibleToRequest(
  req: Request,
  res: Response,
  options: StudentSearchOptions
) {
  const schoolId = res.locals.schoolId!;
  const role = await getRequestGoPilotRole(req, res);

  if (!role || role === "parent") {
    return [];
  }

  if (role !== "teacher") {
    return searchStudents(schoolId, options);
  }

  // Per-homeroom teacher scoping is a GoPilot-only model. At a PassPilot/ClassPilot
  // school (no active GoPilot license) there are no homerooms, so scoping here would
  // wrongly empty a teacher's roster — those teachers keep the normal full view
  // (pre-#84 behavior). Only GoPilot-licensed schools get per-homeroom scoping.
  if (!(await hasActiveGoPilotLicense(schoolId))) {
    return searchStudents(schoolId, options);
  }

  const allowedHomeroomIds = await getTeacherHomeroomIds(req.authUser!.id, schoolId);
  if (allowedHomeroomIds.size === 0) {
    return [];
  }

  if (options?.homeroomId) {
    if (!allowedHomeroomIds.has(options.homeroomId)) {
      return [];
    }
    return searchStudents(schoolId, options);
  }

  const rowsById = new Map<string, Awaited<ReturnType<typeof searchStudents>>[number]>();
  for (const allowedHomeroomId of allowedHomeroomIds) {
    const rows = await searchStudents(schoolId, {
      ...options,
      homeroomId: allowedHomeroomId,
    });
    for (const row of rows) {
      rowsById.set(row.id, row);
    }
  }

  return [...rowsById.values()].sort((a, b) => {
    const byLast = (a.lastName || "").localeCompare(b.lastName || "");
    if (byLast !== 0) return byLast;
    return (a.firstName || "").localeCompare(b.firstName || "");
  });
}

async function canAccessStudentForRequest(
  req: Request,
  res: Response,
  student: Pick<Student, "homeroomId">
): Promise<boolean> {
  const role = await getRequestGoPilotRole(req, res);
  if (!role || role === "parent") {
    return false;
  }
  if (role !== "teacher") {
    return true;
  }
  // Non-GoPilot school: teacher retains normal access (no homeroom model). See
  // searchStudentsVisibleToRequest for the rationale.
  if (!(await hasActiveGoPilotLicense(res.locals.schoolId!))) {
    return true;
  }
  if (!student.homeroomId) {
    return false;
  }
  const allowedHomeroomIds = await getTeacherHomeroomIds(req.authUser!.id, res.locals.schoolId!);
  return allowedHomeroomIds.has(student.homeroomId);
}

// ============================================================================
// Student CRUD
// ============================================================================

// GET /api/students - List students (school-scoped)
router.get("/", ...schoolContext, async (req, res, next) => {
  try {
    const { search, gradeLevel, gradeId, homeroomId, status, dismissalType } = req.query as Record<string, string | undefined>;

    const studentsList = await searchStudentsVisibleToRequest(req, res, {
      search,
      gradeLevel,
      gradeId,
      homeroomId,
      status: status || "active",
      dismissalType,
    });

    // Enrich with car numbers from family_groups and homeroom names
    const studentIds = studentsList.map((s) => s.id);
    let carNumberMap: Record<string, string> = {};
    let homeroomMap: Record<string, { name: string; grade: string }> = {};

    if (studentIds.length > 0) {
      // Get car numbers via family_group_students → family_groups
      const fgRows = await db
        .select({
          studentId: familyGroupStudents.studentId,
          carNumber: familyGroups.carNumber,
        })
        .from(familyGroupStudents)
        .innerJoin(familyGroups, eq(familyGroups.id, familyGroupStudents.familyGroupId))
        .where(eq(familyGroups.schoolId, res.locals.schoolId!));

      for (const row of fgRows) {
        if (row.carNumber) carNumberMap[row.studentId] = row.carNumber;
      }

      // Get homeroom names
      const homeroomIds = [...new Set(studentsList.filter((s) => s.homeroomId).map((s) => s.homeroomId!))];
      if (homeroomIds.length > 0) {
        const hrRows = await db.select().from(homerooms).where(eq(homerooms.schoolId, res.locals.schoolId!));
        for (const hr of hrRows) {
          homeroomMap[hr.id] = { name: hr.name, grade: hr.grade || "" };
        }
      }
    }

    const enriched = studentsList.map((s) => {
      const hr = s.homeroomId ? homeroomMap[s.homeroomId] : undefined;
      return {
        ...s,
        carNumber: carNumberMap[s.id] || null,
        homeroomName: hr?.name || null,
        homeroomGrade: hr?.grade || null,
      };
    });

    return res.json({ students: enriched.map(stripStudentCredentialHash) });
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
      const body = normalizeStudentBody(req.body);
      // Handle grade → gradeLevel (GoPilot sends grade)
      if (body.grade && !body.gradeLevel) { body.gradeLevel = body.grade; delete body.grade; }

      const parsed = createStudentSchema.safeParse(body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      // Guardrail: email required for ClassPilot schools; any email must match domain.
      const emailErr = checkStudentEmail(
        parsed.data.email,
        await studentEmailRules(res.locals.schoolId!)
      );
      if (emailErr) {
        return res.status(400).json({
          error: emailErr.error,
          code: emailErr.code,
          expectedDomain: emailErr.expectedDomain,
          actualDomain: emailErr.actualDomain,
        });
      }

      // Uniqueness: one email per person (student or staff) within the school.
      if (parsed.data.email) {
        const taken = await studentEmailTaken(
          res.locals.schoolId!,
          parsed.data.email.toLowerCase()
        );
        if (taken) {
          return res.status(409).json({ error: taken, code: "STUDENT_EMAIL_TAKEN" });
        }
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
        ...(await classpilotPinHashFromInput(parsed.data.classpilotPin)),
      };

      const student = await createStudent(data);
      return res.status(201).json({ student: stripStudentCredentialHash(student) });
    } catch (err) {
      // Backstop for a race (or badge/code clash) that slipped past the pre-check.
      if (isUniqueViolation(err)) {
        return res.status(409).json({
          error: "A student with this email, badge ID, or code already exists in this school.",
          code: "STUDENT_DUPLICATE",
        });
      }
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
      const rules = await studentEmailRules(res.locals.schoolId!);
      const emailSets = await existingEmailSets(res.locals.schoolId!);
      const batchEmails = new Set<string>();

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

        // Guardrail: email required for ClassPilot; any email must match domain.
        const emailErr = checkStudentEmail(parsed.data.email, rules);
        if (emailErr) {
          errors.push({ index: i, error: emailErr.error });
          continue;
        }

        // Uniqueness: skip rows whose email already belongs to a student/staff
        // in this school, or that repeats earlier in the same batch.
        const emailLc = parsed.data.email?.toLowerCase();
        if (emailLc) {
          const dupErr = duplicateEmailError(emailLc, emailSets, batchEmails);
          if (dupErr) {
            errors.push({ index: i, error: dupErr });
            continue;
          }
          batchEmails.add(emailLc);
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
          ...(await classpilotPinHashFromInput(parsed.data.classpilotPin)),
        });
      }

      const created = await bulkCreateStudents(toInsert);

      // Auto-assign car numbers if school has GoPilot
      let autoAssigned: number | undefined;
      if (created.length > 0) {
        const licenses = await getProductLicenses(res.locals.schoolId!);
        const hasGoPilot = licenses.some(
          (l) => l.product === "GOPILOT" && l.status === "active"
        );
        if (hasGoPilot) {
          const result = await autoAssignFamilyGroups(res.locals.schoolId!);
          autoAssigned = result.assigned;
        }
      }

      return res.status(201).json({
        imported: created.length,
        errors: errors.length > 0 ? errors : undefined,
        total: studentData.length,
        autoAssigned,
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
    return res.send("firstName,lastName,email,studentIdNumber,gradeLevel,classpilotPin\n");
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
    const rules = await studentEmailRules(res.locals.schoolId!);
    const emailSets = await existingEmailSets(res.locals.schoolId!);
    const batchEmails = new Set<string>();

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

      // Guardrail: email required for ClassPilot; any email must match domain.
      const emailErr = checkStudentEmail(email, rules);
      if (emailErr) {
        errors.push({ row: i + 1, error: emailErr.error });
        continue;
      }

      // Uniqueness: skip rows duplicating an existing student/staff email or an
      // earlier row in the same file.
      const emailLc = email?.toLowerCase();
      if (emailLc) {
        const dupErr = duplicateEmailError(emailLc, emailSets, batchEmails);
        if (dupErr) {
          errors.push({ row: i + 1, error: dupErr });
          continue;
        }
        batchEmails.add(emailLc);
      }

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
      const classpilotPin =
        normalized["classpilotpin"] ||
        normalized["classpilotstudentpin"] ||
        normalized["pin"] ||
        null;
      if (classpilotPin && !/^\d{4}$/.test(classpilotPin)) {
        errors.push({ row: i + 1, error: "ClassPilot PIN must be 4 digits" });
        continue;
      }

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
        classpilotPinHash: classpilotPin ? await hashPassword(classpilotPin) : null,
      });
    }

    const created = await bulkCreateStudents(toInsert);

    // Auto-assign car numbers if school has GoPilot
    let autoAssigned: number | undefined;
    if (created.length > 0) {
      const licenses = await getProductLicenses(res.locals.schoolId!);
      const hasGoPilot = licenses.some(
        (l) => l.product === "GOPILOT" && l.status === "active"
      );
      if (hasGoPilot) {
        const result = await autoAssignFamilyGroups(res.locals.schoolId!);
        autoAssigned = result.assigned;
      }
    }

    return res.status(201).json({
      imported: created.length,
      errors: errors.length > 0 ? errors : undefined,
      total: rows.length,
      autoAssigned,
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
      const skipped: { id: string; error: string }[] = [];
      const rules = await studentEmailRules(res.locals.schoolId!);
      const updateItems = updates.filter((item): item is Record<string, unknown> & { id: string } => {
        return Boolean(item && typeof item === "object" && "id" in item && item.id);
      });
      const updateIds = [...new Set(updateItems.map((item) => String(item.id)))];
      const existingStudents = updateIds.length
        ? await db
            .select()
            .from(studentsTable)
            .where(
              and(
                eq(studentsTable.schoolId, res.locals.schoolId!),
                inArray(studentsTable.id, updateIds)
              )
            )
        : [];
      const existingById = new Map(existingStudents.map((student) => [student.id, student]));
      const preparedUpdates: Array<{
        id: string;
        data: Record<string, unknown>;
        classpilotPin: string | null | undefined;
      }> = [];

      for (const item of updateItems) {
        const id = String(item.id);
        const existing = existingById.get(id);
        if (!existing) continue;

        // Guardrail: only validate when the email actually changes (not on
        // resubmit), so a grade/dismissal bulk-edit of a legacy student isn't blocked.
        const rawItemEmail = item.email ?? item.studentEmail;
        const itemEmail = rawItemEmail == null ? rawItemEmail : String(rawItemEmail);
        if (isEmailChanging(itemEmail, existing.emailLc)) {
          const emailErr = checkStudentEmail(itemEmail, rules);
          if (emailErr) {
            skipped.push({ id, error: emailErr.error });
            continue;
          }
          // Uniqueness: don't let an email change collide with another
          // student/staff in the school.
          if (itemEmail) {
            const taken = await studentEmailTaken(res.locals.schoolId!, itemEmail.toLowerCase(), id);
            if (taken) {
              skipped.push({ id, error: taken });
              continue;
            }
          }
        }
        const normalized = normalizeStudentBody(item);
        const { classpilotPin, ...safeItem } = normalized;
        preparedUpdates.push({
          id,
          data: safeItem,
          classpilotPin:
            typeof classpilotPin === "string" || classpilotPin === null
              ? classpilotPin
              : undefined,
        });
      }

      const hashedUpdates = await mapWithConcurrency(
        preparedUpdates,
        CLASSPILOT_PIN_HASH_CONCURRENCY,
        async (item) => ({
          ...item,
          data: {
            ...item.data,
            ...(await classpilotPinHashFromInput(item.classpilotPin)),
          },
        })
      );

      const results = await db.transaction(async (tx) => {
        const rows: unknown[] = [];
        for (const item of hashedUpdates) {
          const [updated] = await tx
            .update(studentsTable)
            .set({ ...prepareStudentUpdateData(item.data), updatedAt: new Date() })
            .where(
              and(
                eq(studentsTable.id, item.id),
                eq(studentsTable.schoolId, res.locals.schoolId!)
              )
            )
            .returning();
          if (updated) rows.push(stripStudentCredentialHash(updated));
        }
        return rows;
      });

      return res.json({
        updated: results.length,
        students: results,
        skipped: skipped.length > 0 ? skipped : undefined,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({
          error: "Duplicate email, badge ID, or code.",
          code: "STUDENT_DUPLICATE",
        });
      }
      next(err);
    }
  }
);

// POST /api/students/classpilot-pins/bulk-generate - Generate 4-digit shared-login PINs
router.post(
  "/classpilot-pins/bulk-generate",
  ...schoolContext,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const requestedIds = Array.isArray(req.body?.studentIds)
        ? new Set(req.body.studentIds.map((id: unknown) => String(id)))
        : null;
      const requestedGrade = normalizeGradeLevel(req.body?.gradeLevel);
      const onlyMissing = req.body?.onlyMissing !== false;
      const students = await getStudentsBySchool(res.locals.schoolId!);
      const eligible = students.filter((student) => {
        if (student.status !== "active") return false;
        if (requestedIds && !requestedIds.has(student.id)) return false;
        if (requestedGrade && normalizeGradeLevel(student.gradeLevel) !== requestedGrade) return false;
        if (onlyMissing && student.classpilotPinHash) return false;
        return true;
      });

      const generatedPins = new Set<string>();
      const pinPlans = eligible.map((student) => ({
        student,
        pin: randomFourDigitPin(generatedPins),
      }));
      const hashedPlans = await mapWithConcurrency(
        pinPlans,
        CLASSPILOT_PIN_HASH_CONCURRENCY,
        async (plan) => ({
          ...plan,
          classpilotPinHash: await hashPassword(plan.pin),
        })
      );

      const generated = await db.transaction(async (tx) => {
        const rows: Array<{ studentId: string; studentName: string; gradeLevel: string | null; pin: string }> = [];
        for (const plan of hashedPlans) {
          const [updated] = await tx
            .update(studentsTable)
            .set({ classpilotPinHash: plan.classpilotPinHash, updatedAt: new Date() })
            .where(
              and(
                eq(studentsTable.id, plan.student.id),
                eq(studentsTable.schoolId, res.locals.schoolId!)
              )
            )
            .returning();
          if (!updated) {
            throw new Error("Could not update one or more student PINs");
          }
          rows.push({
            studentId: updated.id,
            studentName: `${updated.firstName || ""} ${updated.lastName || ""}`.trim() || updated.email || "Student",
            gradeLevel: updated.gradeLevel,
            pin: plan.pin,
          });
        }
        return rows;
      });

      return res.json({ generated });
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
    if (!(await canAccessStudentForRequest(req, res, student))) {
      return res.status(404).json({ error: "Student not found" });
    }
    return res.json({ student: stripStudentCredentialHash(student) });
  } catch (err) {
    next(err);
  }
});

// Normalize incoming student fields from any frontend (ClassPilot, GoPilot, PassPilot)
// Each frontend sends different field conventions; this normalizes to DB column names.
function normalizeStudentBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body = { ...raw };
  // Handle snake_case → camelCase (GoPilot sends first_name, last_name, etc.)
  if (body.first_name && !body.firstName) { body.firstName = body.first_name; delete body.first_name; }
  if (body.last_name && !body.lastName) { body.lastName = body.last_name; delete body.last_name; }
  if (body.grade_level && !body.gradeLevel) { body.gradeLevel = body.grade_level; delete body.grade_level; }
  if (body.dismissal_type && !body.dismissalType) { body.dismissalType = body.dismissal_type; delete body.dismissal_type; }
  if (body.bus_route && !body.busRoute) { body.busRoute = body.bus_route; delete body.bus_route; }
  if (body.afterschool_reason && !body.afterschoolReason) { body.afterschoolReason = body.afterschool_reason; delete body.afterschool_reason; }
  // Handle studentName → firstName/lastName (ClassPilot sends studentName)
  if (body.studentName && !body.firstName) {
    const parts = String(body.studentName).trim().split(/\s+/);
    body.firstName = parts[0] || "";
    body.lastName = parts.slice(1).join(" ") || "";
    delete body.studentName;
  }
  if (body.name && !body.firstName) {
    const parts = String(body.name).trim().split(/\s+/);
    body.firstName = parts[0] || "";
    body.lastName = parts.slice(1).join(" ") || "";
    delete body.name;
  }
  // Handle studentEmail → email
  if (body.studentEmail && !body.email) {
    body.email = body.studentEmail;
    delete body.studentEmail;
  }
  return body;
}

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
      if (!(await canAccessStudentForRequest(req, res, existing))) {
        return res.status(404).json({ error: "Student not found" });
      }

      const parsed = updateStudentSchema.safeParse(normalizeStudentBody(req.body));
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      // Guardrail: only validate when the email actually changes (not on resubmit),
      // so editing a pre-existing student with legacy data isn't blocked. Adding and
      // genuine email changes still validate.
      if (isEmailChanging(parsed.data.email, existing.emailLc)) {
        const emailErr = checkStudentEmail(
          parsed.data.email,
          await studentEmailRules(res.locals.schoolId!)
        );
        if (emailErr) {
          return res.status(400).json({
            error: emailErr.error,
            code: emailErr.code,
            expectedDomain: emailErr.expectedDomain,
            actualDomain: emailErr.actualDomain,
          });
        }
        // Uniqueness: an email change can't collide with another student/staff.
        if (parsed.data.email) {
          const taken = await studentEmailTaken(
            res.locals.schoolId!,
            parsed.data.email.toLowerCase(),
            param(req, "studentId")
          );
          if (taken) {
            return res.status(409).json({ error: taken, code: "STUDENT_EMAIL_TAKEN" });
          }
        }
      }

      const { classpilotPin, ...parsedUpdateData } = parsed.data;
      const updateData: Record<string, unknown> = {
        ...parsedUpdateData,
        ...(await classpilotPinHashFromInput(classpilotPin)),
      };
      if (parsed.data.email !== undefined) {
        updateData.emailLc = parsed.data.email?.toLowerCase() || null;
      }
      for (const key of ["gradeId", "homeroomId", "studentIdNumber", "gradeLevel"]) {
        if (updateData[key] === "") updateData[key] = null;
      }
      // Clear afterschool reason when switching away from afterschool
      if (parsed.data.dismissalType && parsed.data.dismissalType !== "afterschool") {
        updateData.afterschoolReason = null;
      }

      const student = await updateStudent(param(req, "studentId"), updateData);
      return res.json({ student: student ? stripStudentCredentialHash(student) : student });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({
          error: "A student with this email, badge ID, or code already exists in this school.",
          code: "STUDENT_DUPLICATE",
        });
      }
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
      if (!(await canAccessStudentForRequest(req, res, existing))) {
        return res.status(404).json({ error: "Student not found" });
      }

      const parsed = updateStudentSchema.safeParse(normalizeStudentBody(req.body));
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      // Guardrail: only validate when the email actually changes (not on resubmit),
      // so editing a pre-existing student with legacy data isn't blocked. Adding and
      // genuine email changes still validate.
      if (isEmailChanging(parsed.data.email, existing.emailLc)) {
        const emailErr = checkStudentEmail(
          parsed.data.email,
          await studentEmailRules(res.locals.schoolId!)
        );
        if (emailErr) {
          return res.status(400).json({
            error: emailErr.error,
            code: emailErr.code,
            expectedDomain: emailErr.expectedDomain,
            actualDomain: emailErr.actualDomain,
          });
        }
        // Uniqueness: an email change can't collide with another student/staff.
        if (parsed.data.email) {
          const taken = await studentEmailTaken(
            res.locals.schoolId!,
            parsed.data.email.toLowerCase(),
            param(req, "studentId")
          );
          if (taken) {
            return res.status(409).json({ error: taken, code: "STUDENT_EMAIL_TAKEN" });
          }
        }
      }

      const { classpilotPin, ...parsedUpdateData } = parsed.data;
      const updateData: Record<string, unknown> = {
        ...parsedUpdateData,
        ...(await classpilotPinHashFromInput(classpilotPin)),
      };
      if (parsed.data.email !== undefined) {
        updateData.emailLc = parsed.data.email?.toLowerCase() || null;
      }
      for (const key of ["gradeId", "homeroomId", "studentIdNumber", "gradeLevel"]) {
        if (updateData[key] === "") updateData[key] = null;
      }
      // Clear afterschool reason when switching away from afterschool
      if (parsed.data.dismissalType && parsed.data.dismissalType !== "afterschool") {
        updateData.afterschoolReason = null;
      }

      const student = await updateStudent(param(req, "studentId"), updateData);
      return res.json({ student: student ? stripStudentCredentialHash(student) : student });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({
          error: "A student with this email, badge ID, or code already exists in this school.",
          code: "STUDENT_DUPLICATE",
        });
      }
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
