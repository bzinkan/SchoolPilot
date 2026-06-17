import {
  getProductLicenses,
  getSchoolById,
  getStudentByEmail,
  getStudentEmailsBySchool,
  getStaffBySchool,
  normalizeDomain,
  studentEmailDomainMatches,
  validateStaffEmailDomainForSchool,
} from "./storage.js";

export type StudentEmailRules = {
  requireEmail: boolean;
  expectedDomain: string | null;
};

export type StudentEmailPolicyError = {
  code: string;
  error: string;
  expectedDomain: string | null;
  actualDomain: string | null;
};

export type ExistingEmailSets = {
  students: Set<string>;
  staff: Set<string>;
};

export function emailDomainError(
  expectedDomain: string | null,
  actualDomain: string | null
): string {
  return `Student email must use the school's domain (@${expectedDomain}); got @${actualDomain ?? "?"}.`;
}

export function isUniqueViolation(err: unknown): boolean {
  return !!(
    err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "23505"
  );
}

export function isEmailChanging(
  newEmail: unknown,
  existingEmailLc: string | null
): boolean {
  if (newEmail === undefined) return false;
  const lc = newEmail == null ? null : String(newEmail).trim().toLowerCase() || null;
  return lc !== (existingEmailLc || null);
}

export async function studentEmailRules(
  schoolId: string
): Promise<StudentEmailRules> {
  const [school, licenses] = await Promise.all([
    getSchoolById(schoolId),
    getProductLicenses(schoolId),
  ]);
  const requireEmail = licenses.some(
    (license) => license.product === "CLASSPILOT" && license.status === "active"
  );
  return { requireEmail, expectedDomain: normalizeDomain(school?.domain) };
}

export function checkStudentEmail(
  email: string | null | undefined,
  rules: StudentEmailRules
): StudentEmailPolicyError | null {
  const normalizedEmail = typeof email === "string" ? email.trim() : email;
  if (!normalizedEmail) {
    if (rules.requireEmail) {
      return {
        code: "STUDENT_EMAIL_REQUIRED",
        error:
          "Student email is required because this school uses ClassPilot, which identifies students by their school Google email.",
        expectedDomain: rules.expectedDomain,
        actualDomain: null,
      };
    }
    return null;
  }

  const domainResult = studentEmailDomainMatches(
    normalizedEmail,
    rules.expectedDomain
  );
  if (!domainResult.ok) {
    return {
      code: "STUDENT_EMAIL_DOMAIN_MISMATCH",
      error: emailDomainError(domainResult.expectedDomain, domainResult.actualDomain),
      expectedDomain: domainResult.expectedDomain,
      actualDomain: domainResult.actualDomain,
    };
  }
  return null;
}

export async function studentEmailTaken(
  schoolId: string,
  emailLc: string,
  excludeStudentId?: string
): Promise<string | null> {
  const normalizedEmailLc = emailLc.trim().toLowerCase();
  const existing = await getStudentByEmail(schoolId, normalizedEmailLc);
  if (existing && existing.id !== excludeStudentId) {
    return "A student with this email already exists in this school.";
  }
  const staff = await getStaffBySchool(schoolId);
  if (staff.some((row) => (row.user.email || "").toLowerCase() === normalizedEmailLc)) {
    return "This email is already used by a staff account; each person needs a unique email.";
  }
  return null;
}

export async function existingEmailSets(
  schoolId: string
): Promise<ExistingEmailSets> {
  const [students, staffRows] = await Promise.all([
    getStudentEmailsBySchool(schoolId),
    getStaffBySchool(schoolId),
  ]);
  const staff = new Set(
    staffRows.map((row) => (row.user.email || "").toLowerCase()).filter(Boolean)
  );
  return { students, staff };
}

export function duplicateEmailError(
  emailLc: string,
  sets: ExistingEmailSets,
  batch: Set<string>
): string | null {
  const normalizedEmailLc = emailLc.trim().toLowerCase();
  if (sets.staff.has(normalizedEmailLc)) {
    return "This email is already used by a staff account; each person needs a unique email.";
  }
  if (sets.students.has(normalizedEmailLc) || batch.has(normalizedEmailLc)) {
    return "Duplicate student email; this address is already in use in this school.";
  }
  return null;
}

export async function validateStaffImportEmailForSchool(
  email: string,
  schoolId: string
): Promise<StudentEmailPolicyError | null> {
  const validation = await validateStaffEmailDomainForSchool(email, schoolId);
  if (!validation.ok) {
    return {
      code: validation.code || "STAFF_EMAIL_DOMAIN_MISMATCH",
      error: validation.message || "Staff email is not valid for this school.",
      expectedDomain: validation.expectedDomain ?? null,
      actualDomain: validation.actualDomain ?? null,
    };
  }

  const emailLc = email.trim().toLowerCase();
  const studentClash = await getStudentByEmail(schoolId, emailLc);
  if (studentClash) {
    return {
      code: "EMAIL_IN_USE_BY_STUDENT",
      error:
        "This email is already assigned to a student in this school. Each person needs a unique email.",
      expectedDomain: validation.expectedDomain ?? null,
      actualDomain: validation.actualDomain ?? null,
    };
  }

  return null;
}
