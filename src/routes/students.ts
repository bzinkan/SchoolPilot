import { Router } from "express";
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
  bulkCreateStudents,
  getProductLicenses,
  autoAssignFamilyGroups,
  getSchoolById,
  normalizeDomain,
  studentEmailDomainMatches,
  getStudentByEmail,
  getStudentEmailsBySchool,
  getStaffBySchool,
} from "../services/storage.js";
import type { InsertStudent } from "../schema/students.js";
import db from "../db.js";
import { eq } from "drizzle-orm";
import { familyGroups, familyGroupStudents } from "../schema/gopilot.js";
import { homerooms } from "../schema/gopilot.js";

const router = Router();

function param(req: { params: Record<string, unknown> }, key: string): string {
  return String(req.params[key] ?? "");
}

// Fetch the school's expected email domain once per request (so bulk/CSV imports
// validate every row against it without a DB hit per row).
async function schoolEmailDomain(schoolId: string): Promise<string | null> {
  const school = await getSchoolById(schoolId);
  return normalizeDomain(school?.domain);
}

// Human-readable rejection message for a student email whose domain doesn't match.
function emailDomainError(expectedDomain: string | null, actualDomain: string | null): string {
  return `Student email must use the school's domain (@${expectedDomain}); got @${actualDomain ?? "?"}.`;
}

// True only when an edit actually CHANGES the email (case-insensitive), vs merely
// resubmitting the current value. Email guardrails run only on a real change, so
// editing a pre-existing student whose legacy email doesn't conform (wrong domain,
// or already used) never breaks an unrelated edit. Adding/genuine changes still
// validate. `undefined` (field not sent) is never a change.
function isEmailChanging(newEmail: unknown, existingEmailLc: string | null): boolean {
  if (newEmail === undefined) return false;
  const lc = newEmail == null ? null : String(newEmail).toLowerCase() || null;
  return lc !== (existingEmailLc || null);
}

// Per-request rules for student emails. A school running ClassPilot identifies
// students by their school Google email (the extension reports the Chrome login
// email), so email is REQUIRED when adding students there; PassPilot/GoPilot-only
// schools keep it optional (badge/ID kids). Any provided email must match the
// school domain. Fetched once per request so bulk imports stay one-DB-hit.
async function studentEmailRules(
  schoolId: string
): Promise<{ requireEmail: boolean; expectedDomain: string | null }> {
  const [school, licenses] = await Promise.all([
    getSchoolById(schoolId),
    getProductLicenses(schoolId),
  ]);
  const requireEmail = licenses.some(
    (l) => l.product === "CLASSPILOT" && l.status === "active"
  );
  return { requireEmail, expectedDomain: normalizeDomain(school?.domain) };
}

// Postgres unique_violation — map a duplicate (email / badge / code) to a clear
// 409 instead of the generic 500 the error handler would otherwise return.
function isUniqueViolation(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

// Single-record uniqueness check: reject if this email already belongs to another
// student in the school (any status) or to a staff account here. One email per
// person, student or teacher. excludeStudentId skips the record being edited.
async function studentEmailTaken(
  schoolId: string,
  emailLc: string,
  excludeStudentId?: string
): Promise<string | null> {
  const existing = await getStudentByEmail(schoolId, emailLc);
  if (existing && existing.id !== excludeStudentId) {
    return "A student with this email already exists in this school.";
  }
  const staff = await getStaffBySchool(schoolId);
  if (staff.some((r) => (r.user.email || "").toLowerCase() === emailLc)) {
    return "This email is already used by a staff account — each person needs a unique email.";
  }
  return null;
}

// Bulk variant: pre-fetch the school's existing student + staff emails once so
// every row is checked against them (and earlier rows in the same file) with no
// per-row DB hit.
async function existingEmailSets(
  schoolId: string
): Promise<{ students: Set<string>; staff: Set<string> }> {
  const [students, staffRows] = await Promise.all([
    getStudentEmailsBySchool(schoolId),
    getStaffBySchool(schoolId),
  ]);
  const staff = new Set(
    staffRows.map((r) => (r.user.email || "").toLowerCase()).filter(Boolean)
  );
  return { students, staff };
}

function duplicateEmailError(
  emailLc: string,
  sets: { students: Set<string>; staff: Set<string> },
  batch: Set<string>
): string | null {
  if (sets.staff.has(emailLc)) {
    return "This email is already used by a staff account — each person needs a unique email.";
  }
  if (sets.students.has(emailLc) || batch.has(emailLc)) {
    return "Duplicate student email — this address is already in use in this school.";
  }
  return null;
}

// Validate one student email against the rules. Returns null when OK, otherwise a
// 400-shaped error. A missing email is only rejected when required (ClassPilot).
function checkStudentEmail(
  email: string | null | undefined,
  rules: { requireEmail: boolean; expectedDomain: string | null }
): { code: string; error: string; expectedDomain: string | null; actualDomain: string | null } | null {
  if (!email) {
    if (rules.requireEmail) {
      return {
        code: "STUDENT_EMAIL_REQUIRED",
        error:
          "Student email is required — this school uses ClassPilot, which identifies students by their school Google email.",
        expectedDomain: rules.expectedDomain,
        actualDomain: null,
      };
    }
    return null;
  }
  const dom = studentEmailDomainMatches(email, rules.expectedDomain);
  if (!dom.ok) {
    return {
      code: "STUDENT_EMAIL_DOMAIN_MISMATCH",
      error: emailDomainError(dom.expectedDomain, dom.actualDomain),
      expectedDomain: dom.expectedDomain,
      actualDomain: dom.actualDomain,
    };
  }
  return null;
}

router.use(authenticate);

const schoolContext = [requireSchoolContext, requireActiveSchool, requireProductLicense("CLASSPILOT", "PASSPILOT", "GOPILOT")] as const;

// ============================================================================
// Student CRUD
// ============================================================================

// GET /api/students - List students (school-scoped)
router.get("/", ...schoolContext, async (req, res, next) => {
  try {
    const { search, gradeLevel, gradeId, homeroomId, status, dismissalType } = req.query as Record<string, string | undefined>;

    const studentsList = await searchStudents(res.locals.schoolId!, {
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

    return res.json({ students: enriched });
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
      };

      const student = await createStudent(data);
      return res.status(201).json({ student });
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
      const results: unknown[] = [];
      const skipped: { id: string; error: string }[] = [];
      const expectedDomain = await schoolEmailDomain(res.locals.schoolId!);
      for (const item of updates) {
        if (item.id) {
          // Verify each student belongs to the caller's school before mutating.
          const existing = await getStudentById(item.id);
          if (!existing || existing.schoolId !== res.locals.schoolId) continue;
          // Guardrail: only validate when the email actually changes (not on
          // resubmit), so a grade/dismissal bulk-edit of a legacy student isn't blocked.
          const itemEmail = item.email ?? item.studentEmail;
          if (isEmailChanging(itemEmail, existing.emailLc)) {
            const dom = studentEmailDomainMatches(itemEmail, expectedDomain);
            if (!dom.ok) {
              skipped.push({ id: item.id, error: emailDomainError(dom.expectedDomain, dom.actualDomain) });
              continue;
            }
            // Uniqueness: don't let an email change collide with another
            // student/staff in the school.
            if (itemEmail) {
              const taken = await studentEmailTaken(res.locals.schoolId!, String(itemEmail).toLowerCase(), item.id);
              if (taken) {
                skipped.push({ id: item.id, error: taken });
                continue;
              }
            }
          }
          try {
            const updated = await updateStudent(item.id, item);
            if (updated) results.push(updated);
          } catch (err) {
            if (isUniqueViolation(err)) {
              skipped.push({ id: item.id, error: "Duplicate email, badge ID, or code." });
              continue;
            }
            throw err;
          }
        }
      }
      return res.json({
        updated: results.length,
        students: results,
        skipped: skipped.length > 0 ? skipped : undefined,
      });
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
        const dom = studentEmailDomainMatches(
          parsed.data.email,
          await schoolEmailDomain(res.locals.schoolId!)
        );
        if (!dom.ok) {
          return res.status(400).json({
            error: emailDomainError(dom.expectedDomain, dom.actualDomain),
            code: "STUDENT_EMAIL_DOMAIN_MISMATCH",
            expectedDomain: dom.expectedDomain,
            actualDomain: dom.actualDomain,
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

      const updateData: Record<string, unknown> = { ...parsed.data };
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
      return res.json({ student });
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
        const dom = studentEmailDomainMatches(
          parsed.data.email,
          await schoolEmailDomain(res.locals.schoolId!)
        );
        if (!dom.ok) {
          return res.status(400).json({
            error: emailDomainError(dom.expectedDomain, dom.actualDomain),
            code: "STUDENT_EMAIL_DOMAIN_MISMATCH",
            expectedDomain: dom.expectedDomain,
            actualDomain: dom.actualDomain,
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

      const updateData: Record<string, unknown> = { ...parsed.data };
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
      return res.json({ student });
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
