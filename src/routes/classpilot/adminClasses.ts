import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { logAudit } from "../../services/audit.js";
import {
  IdentityEmailConflictError,
  addGroupStudentsDetailed,
  archiveGroup,
  autoAssignFamilyGroups,
  createStudent,
  findOverlappingScheduledAdminClass,
  getAdminClassSummariesBySchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupTeacherSummaries,
  getMembershipByUserAndSchool,
  getProductLicenses,
  getStudentByEmail,
  getStudentsByIds,
  getUserByEmail,
  getUserById,
  groupHasTeachingHistory,
  hardDeleteGroupWithCleanup,
  removeGroupStudent,
  reactivateInactiveStudentForRosterImport,
  updateAdminClassWithTeachers,
  upsertAdminClassroomClass,
  upsertClassroomCourse,
  upsertClassroomCourseStudents,
  validateStaffEmailDomainForSchool,
} from "../../services/storage.js";
import { recordImportRun } from "../../services/importLog.js";
import { freezeScheduledOccurrenceIfDue } from "../../services/classpilotScheduledStart.js";
import {
  checkStudentEmail,
  studentEmailRules,
  studentEmailTaken,
  type StudentEmailRules,
} from "../../services/studentEmailPolicy.js";
import {
  encryptClassPilotPin,
  generatedPinForStudent,
  hashClassPilotPin,
  randomFourDigitClassPilotPin,
  type GeneratedClassPilotPin,
} from "../../services/classpilotPins.js";
import {
  CLASSROOM_COURSE_PREVIEW_LIMIT,
  CLASSROOM_FANOUT_CONCURRENCY,
  classroomCourseStaffFromTeachers,
  getRosterClassroomClientForSchool,
  listClassroomCourseTeachers,
  listClassroomCourses,
  recordRosterConnectorSync,
} from "../../services/googleRosterConnector.js";
import { mapWithConcurrency } from "../../util/concurrency.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

const TEACHABLE_ROLES = new Set(["teacher", "admin", "school_admin"]);
const GRADE_VALUES = new Set(["PK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
// Default ON; set exactly "false" to hide Google Classroom class import (see .env.example).
const CLASSROOM_IMPORT_ENABLED = process.env.CLASSPILOT_CLASSROOM_IMPORT_ENABLED !== "false";
function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function actor(req: any, res: any) {
  return {
    schoolId: res.locals.schoolId!,
    userId: req.authUser?.id ?? null,
    userEmail: req.authUser?.email ?? undefined,
    userRole: res.locals.membershipRole,
  };
}

function routeError(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function normalizeGrade(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const compact = raw.toLowerCase().replace(/\s+/g, "").replace(/-/g, "");
  if (["pk", "prek", "prekindergarten", "prekindergarden"].includes(compact)) return "PK";
  if (["k", "kg", "kindergarten", "kindergarden"].includes(compact)) return "K";
  const numeric = compact.replace(/(st|nd|rd|th)$/i, "");
  if (/^\d+$/.test(numeric)) {
    const normalized = String(parseInt(numeric, 10));
    if (GRADE_VALUES.has(normalized)) return normalized;
  }
  throw routeError("gradeLevel must be PK, K, or 1-12", 400, "INVALID_GRADE");
}

function normalizeTime(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw routeError("Time must be in HH:MM format", 400, "INVALID_TIME");
  }
  const parts = raw.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw routeError("Time must be in HH:MM format", 400, "INVALID_TIME");
  }
  return raw;
}

async function validateTeachableUser(userId: string, schoolId: string) {
  const [membership, user] = await Promise.all([
    getMembershipByUserAndSchool(userId, schoolId),
    getUserById(userId),
  ]);
  if (!membership || !user || !TEACHABLE_ROLES.has(membership.role)) {
    throw routeError("Teacher not found in this school", 404, "TEACHER_NOT_FOUND");
  }
  const domain = await validateStaffEmailDomainForSchool(user.email, schoolId);
  if (!domain.ok) {
    throw routeError(domain.message || "Staff email domain does not match this school", 400, domain.code);
  }
  return { membership, user };
}

async function validateTeachers(primaryTeacherId: string, coTeacherIds: unknown, schoolId: string) {
  const coTeachers = Array.isArray(coTeacherIds) ? coTeacherIds.map(String) : [];
  const uniqueCoTeachers = Array.from(new Set(coTeachers.filter((id) => id && id !== primaryTeacherId)));
  await validateTeachableUser(primaryTeacherId, schoolId);
  for (const teacherId of uniqueCoTeachers) {
    await validateTeachableUser(teacherId, schoolId);
  }
  return uniqueCoTeachers;
}

async function validateSchedule(options: {
  schoolId: string;
  teacherId: string;
  scheduleEnabled: boolean;
  blockStartTime: unknown;
  blockEndTime: unknown;
  excludeGroupId?: string;
}) {
  if (!options.scheduleEnabled) {
    return { blockStartTime: null, blockEndTime: null };
  }
  const blockStartTime = normalizeTime(options.blockStartTime);
  const blockEndTime = normalizeTime(options.blockEndTime);
  if (!blockStartTime || !blockEndTime) {
    throw routeError("blockStartTime and blockEndTime are required when scheduling is enabled", 400, "SCHEDULE_TIMES_REQUIRED");
  }
  if (blockStartTime >= blockEndTime) {
    throw routeError("blockStartTime must be before blockEndTime", 400, "SCHEDULE_TIME_ORDER");
  }
  const overlap = await findOverlappingScheduledAdminClass({
    schoolId: options.schoolId,
    teacherId: options.teacherId,
    blockStartTime,
    blockEndTime,
    excludeGroupId: options.excludeGroupId,
  });
  if (overlap) {
    throw routeError(`Schedule overlaps with ${overlap.name}`, 409, "SCHEDULE_OVERLAP");
  }
  return { blockStartTime, blockEndTime };
}

async function serializeClass(group: any, schoolId: string) {
  const teachers = await getGroupTeacherSummaries(group.id, schoolId);
  const primaryTeacher = teachers.find((entry) => entry.relationshipRole === "primary")?.teacher || null;
  const coTeachers = teachers
    .filter((entry) => entry.relationshipRole === "co-teacher")
    .map((entry) => entry.teacher);
  return {
    ...group,
    primaryTeacher,
    coTeachers,
  };
}

async function getAuthedClassroom(userId: string, schoolId: string) {
  void userId;
  return (await getRosterClassroomClientForSchool(schoolId)).classroom;
}

function normalizeGoogleClassroomError(err: any) {
  const statusCode = Number(err?.status || err?.statusCode || (typeof err?.code === "number" ? err.code : 0));
  if (err?.code === "GOOGLE_CONNECTOR_REQUIRED" || err?.message?.includes("GOOGLE_CONNECTOR_REQUIRED")) {
    return routeError(err.message || "Connect the Google Workspace Roster Connector.", 400, "GOOGLE_CONNECTOR_REQUIRED");
  }
  if (statusCode === 401 || err?.message?.includes("invalid_grant")) {
    return routeError("NO_TOKENS: Reconnect Google Classroom for this school.", 400, "NO_TOKENS");
  }
  if (statusCode === 403) {
    return routeError(
      "INSUFFICIENT_PERMISSIONS: Google Classroom access was denied. Reconnect Google Classroom with course, roster, and email profile access.",
      403,
      "INSUFFICIENT_PERMISSIONS"
    );
  }
  if (err?.code && typeof err.code === "string") {
    return routeError(err.message || "Google Classroom request failed", err.status || 400, err.code);
  }
  return err;
}

async function listCourseStudents(classroom: any, courseId: string) {
  const students: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await classroom.courses.students.list({
      courseId,
      pageSize: 100,
      pageToken,
    });
    students.push(...(response.data.students || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return students;
}

async function getCourseMetadata(classroom: any, courseId: string, fallback?: any) {
  try {
    const response = await classroom.courses.get({ id: courseId });
    return response.data || fallback || {};
  } catch {
    return fallback || {};
  }
}

async function hasActiveClassPilotLicense(schoolId: string): Promise<boolean> {
  const licenses = await getProductLicenses(schoolId);
  return licenses.some(
    (license) => license.product === "CLASSPILOT" && license.status === "active"
  );
}

async function maybeAutoAssignGoPilotFamilies(schoolId: string, imported: number) {
  if (imported === 0) return undefined;
  const licenses = await getProductLicenses(schoolId);
  const hasGoPilot = licenses.some(
    (license) => license.product === "GOPILOT" && license.status === "active"
  );
  return hasGoPilot ? autoAssignFamilyGroups(schoolId) : undefined;
}

function teacherPreview(entry: { user: any; membership?: any }) {
  const user = entry.user;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    role: entry.membership?.role || null,
  };
}

type TeacherPreviewSummary = ReturnType<typeof teacherPreview>;

/**
 * Request-scoped Google-email -> teachable SchoolPilot staff resolver.
 * Results are cached per lowercased email. Resolution never throws: an
 * unknown email, an ambiguous identity (IdentityEmailConflictError), a
 * non-teachable role, or a domain mismatch all resolve to null so the
 * course is surfaced as "needs_teacher" instead of failing the preview.
 */
function teacherResolver(schoolId: string) {
  const cache = new Map<string, Promise<TeacherPreviewSummary | null>>();
  return (email: string | null | undefined): Promise<TeacherPreviewSummary | null> => {
    const emailLc = String(email || "").trim().toLowerCase();
    if (!emailLc) return Promise.resolve(null);
    let pending = cache.get(emailLc);
    if (!pending) {
      pending = (async () => {
        try {
          const user = await getUserByEmail(emailLc);
          if (!user) return null;
          return teacherPreview(await validateTeachableUser(user.id, schoolId));
        } catch (error: any) {
          if (!(error instanceof IdentityEmailConflictError) && error?.expose !== true) {
            console.warn("[classpilot] Classroom teacher resolution failed", {
              schoolId,
              code: error?.code || null,
              message: error?.message || String(error),
            });
          }
          return null;
        }
      })();
      cache.set(emailLc, pending);
    }
    return pending;
  };
}

type TeacherResolver = ReturnType<typeof teacherResolver>;

/**
 * Resolves a Classroom course's owner and co-teachers to teachable SchoolPilot
 * staff. Ownership is matched on the Google `ownerId`, so an admin who owns a
 * course in Classroom resolves to themselves exactly like any teacher. The
 * co-teacher list never contains the owner.
 */
async function resolveCourseStaff(
  classroom: any,
  course: { id?: string | null; ownerId?: string | null },
  resolve: TeacherResolver
): Promise<{ ownerEmail: string | null; owner: TeacherPreviewSummary | null; coTeachers: TeacherPreviewSummary[] }> {
  const courseId = String(course?.id || "").trim();
  if (!courseId) return { ownerEmail: null, owner: null, coTeachers: [] };
  const teachers = await listClassroomCourseTeachers(classroom, courseId);
  const staff = classroomCourseStaffFromTeachers(course, teachers);
  const owner = await resolve(staff.ownerEmail);
  const candidates = await Promise.all(staff.coTeacherEmails.map((email) => resolve(email)));
  const seen = new Set<string>(owner ? [String(owner.id)] : []);
  const coTeachers: TeacherPreviewSummary[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(String(candidate.id))) continue;
    seen.add(String(candidate.id));
    coTeachers.push(candidate);
  }
  return { ownerEmail: staff.ownerEmail, owner, coTeachers };
}

type ClassroomStudentUpsertResult = {
  status: "imported" | "updated" | "skipped";
  restored?: boolean;
  studentId?: string;
  googleUserId?: string | null;
  emailLc?: string | null;
  generatedPin?: GeneratedClassPilotPin;
};

type SelectedClassroomCourse = {
  googleCourseId: string;
  primaryTeacherId: string;
  coTeacherIds?: string[];
  gradeLevel?: string | null;
  schoolYear?: string | null;
  term?: string | null;
  periodLabel?: string | null;
};

async function upsertStudentFromClassroom(
  schoolId: string,
  googleStudent: any,
  options: {
    gradeLevel?: string | null;
    rules: StudentEmailRules;
    autoGenerateClassPilotPins?: boolean;
    usedPins?: Set<string>;
    actor: {
      userId: string | null;
      userEmail?: string;
      userRole?: string;
      source: string;
    };
  }
): Promise<ClassroomStudentUpsertResult> {
  const email = googleStudent.profile?.emailAddress?.trim();
  if (!email) return { status: "skipped" };

  const emailLc = email.toLowerCase();
  const emailErr = checkStudentEmail(email, options.rules);
  if (emailErr) {
    throw Object.assign(new Error(emailErr.error), { code: emailErr.code });
  }
  const firstName = googleStudent.profile?.name?.givenName || email.split("@")[0] || "";
  const lastName = googleStudent.profile?.name?.familyName || "";
  const existing = await getStudentByEmail(schoolId, emailLc);
  const taken = await studentEmailTaken(schoolId, emailLc, existing?.id);
  if (taken) {
    throw Object.assign(new Error(taken), { code: "STUDENT_EMAIL_TAKEN" });
  }

  if (existing) {
    const result = await reactivateInactiveStudentForRosterImport(schoolId, emailLc, {
      firstName: firstName || existing.firstName,
      lastName: lastName || existing.lastName,
      email,
      googleUserId: googleStudent.userId || existing.googleUserId || undefined,
      ...(options.gradeLevel ? { gradeLevel: options.gradeLevel } : {}),
    }, options.actor);
    const updated = result.student || existing;
    return {
      status: "updated",
      restored: result.reactivated,
      studentId: updated?.id || existing.id,
      googleUserId: googleStudent.userId || updated?.googleUserId || existing.googleUserId || null,
      emailLc,
    };
  }

  const pin = options.autoGenerateClassPilotPins
    ? randomFourDigitClassPilotPin(options.usedPins)
    : null;
  const student = await createStudent({
    schoolId,
    firstName,
    lastName,
    email,
    gradeLevel: options.gradeLevel || undefined,
    googleUserId: googleStudent.userId || undefined,
    classpilotPinHash: pin ? await hashClassPilotPin(pin) : undefined,
    classpilotPinEncrypted: pin ? encryptClassPilotPin(pin) : undefined,
    status: "active",
  });
  return {
    status: "imported",
    studentId: student.id,
    googleUserId: googleStudent.userId || null,
    emailLc,
    generatedPin: pin ? generatedPinForStudent(student, pin) : undefined,
  };
}

function readImportCourses(body: any): SelectedClassroomCourse[] {
  const rawCourses = Array.isArray(body?.courses)
    ? body.courses
    : Array.isArray(body?.selectedCourses)
      ? body.selectedCourses
      : [];
  return rawCourses.map((course: any) => ({
    googleCourseId: String(course.googleCourseId || course.courseId || "").trim(),
    primaryTeacherId: course.primaryTeacherId || course.teacherId ? String(course.primaryTeacherId || course.teacherId) : "",
    coTeacherIds: Array.isArray(course.coTeacherIds) ? course.coTeacherIds.map(String) : undefined,
    gradeLevel: course.gradeLevel === undefined && course.grade === undefined ? undefined : normalizeGrade(course.gradeLevel ?? course.grade),
    schoolYear: course.schoolYear === undefined ? undefined : (course.schoolYear ? String(course.schoolYear) : null),
    term: course.term === undefined ? undefined : (course.term ? String(course.term) : null),
    periodLabel: course.periodLabel === undefined ? undefined : (course.periodLabel ? String(course.periodLabel) : null),
  }));
}

router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const rows = await getAdminClassSummariesBySchool(schoolId, {
      status: String(req.query.status || "active"),
      schoolYear: req.query.schoolYear ? String(req.query.schoolYear) : undefined,
      term: req.query.term ? String(req.query.term) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
    });
    const classes = await Promise.all(rows.map((row) => serializeClass(row, schoolId)));
    return res.json({ classes });
  } catch (err) {
    next(err);
  }
});

router.get("/classroom/import-preview", ...auth, async (req, res, next) => {
  try {
    if (!CLASSROOM_IMPORT_ENABLED) {
      return res.json({ enabled: false, courses: [], truncated: false, limit: CLASSROOM_COURSE_PREVIEW_LIMIT });
    }
    const schoolId = res.locals.schoolId!;
    const classroom = await getAuthedClassroom(req.authUser!.id, schoolId);
    const existing = await getAdminClassSummariesBySchool(schoolId, { status: "all" });
    const existingByGoogleId = new Map(existing.filter((row) => row.googleClassroomCourseId).map((row) => [row.googleClassroomCourseId, row]));
    const resolveTeacher = teacherResolver(schoolId);
    // Domain-wide listing through the delegated admin (no teacherId filter),
    // capped so a large district preview stays bounded.
    const { courses, truncated } = await listClassroomCourses(classroom, {
      maxCourses: CLASSROOM_COURSE_PREVIEW_LIMIT,
    });
    const normalized = await mapWithConcurrency(courses, CLASSROOM_FANOUT_CONCURRENCY, async (course: any) => {
      const [students, staff] = await Promise.all([
        listCourseStudents(classroom, course.id),
        resolveCourseStaff(classroom, course, resolveTeacher),
      ]);
      const existingClass = existingByGoogleId.get(course.id);
      let existingPrimary: TeacherPreviewSummary | null = null;
      if (existingClass) {
        const teachers = await getGroupTeacherSummaries(existingClass.id, schoolId);
        existingPrimary = teachers.find((entry) => entry.relationshipRole === "primary")?.teacher || null;
      }
      // Match on the existing SchoolPilot class first, then on the Classroom
      // owner. The importing admin is never used as a fallback.
      const matchedTeacher = existingPrimary ?? staff.owner;
      const matchSource = existingPrimary ? "existing_class" : staff.owner ? "classroom_owner" : null;
      return {
        googleCourseId: course.id,
        name: course.name || `Class ${course.id}`,
        section: course.section || null,
        ownerEmail: staff.ownerEmail,
        matchedTeacher,
        matchSource,
        suggestedCoTeachers: staff.coTeachers,
        studentCount: students.length,
        existingClassId: existingClass?.id || null,
        importability: existingClass ? "update" : matchedTeacher ? "ready" : "needs_teacher",
      };
    });
    return res.json({ enabled: true, courses: normalized, truncated, limit: CLASSROOM_COURSE_PREVIEW_LIMIT });
  } catch (err) {
    next(normalizeGoogleClassroomError(err));
  }
});

router.post("/classroom/import", ...auth, async (req, res, next) => {
  try {
    if (!CLASSROOM_IMPORT_ENABLED) {
      return res.status(404).json({
        error: "Google Classroom class import is not enabled.",
        code: "CLASSROOM_IMPORT_DISABLED",
      });
    }
    const schoolId = res.locals.schoolId!;
    const selectedCourses = readImportCourses(req.body).filter((course) => course.googleCourseId);
    if (selectedCourses.length === 0) {
      throw routeError("At least one Google Classroom course is required", 400, "COURSES_REQUIRED");
    }

    const classroom = await getAuthedClassroom(req.authUser!.id, schoolId);
    const existing = await getAdminClassSummariesBySchool(schoolId, { status: "all" });
    const existingByGoogleId = new Map(existing.filter((row) => row.googleClassroomCourseId).map((row) => [row.googleClassroomCourseId, row]));
    const resolveTeacher = teacherResolver(schoolId);

    const rules = await studentEmailRules(schoolId);
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const usedPins = new Set<string>();
    const generatedPins: GeneratedClassPilotPin[] = [];
    const failures: string[] = [];
    const results: any[] = [];
    let totalFound = 0;
    let totalImported = 0;
    let totalUpdated = 0;
    let totalRestored = 0;
    let totalSkipped = 0;
    let importedCourses = 0;
    let updatedCourses = 0;
    const lifecycleActor = {
      userId: req.authUser?.id ?? null,
      userEmail: req.authUser?.email ?? undefined,
      userRole: res.locals.membershipRole,
      source: "classpilot_classroom_import",
    };

    for (const selected of selectedCourses) {
      const courseId = selected.googleCourseId;
      const existingClass = existingByGoogleId.get(courseId);
      let courseMeta: any = null;
      let primaryTeacherId = selected.primaryTeacherId || existingClass?.teacherId || "";
      let requestedCoTeacherIds: string[] | undefined = selected.coTeacherIds;
      if (!primaryTeacherId || (!existingClass && requestedCoTeacherIds === undefined)) {
        // Fall back to the Classroom owner (admins who teach resolve to
        // themselves through this same path). The importing admin is never
        // stamped onto a course owned by someone else.
        courseMeta = await getCourseMetadata(classroom, courseId, selected);
        const staff = await resolveCourseStaff(
          classroom,
          { id: courseId, ownerId: courseMeta.ownerId ?? null },
          resolveTeacher
        );
        if (!primaryTeacherId) primaryTeacherId = staff.owner?.id ? String(staff.owner.id) : "";
        if (!existingClass && requestedCoTeacherIds === undefined) {
          requestedCoTeacherIds = staff.coTeachers.map((teacher) => String(teacher.id));
        }
      }
      if (!primaryTeacherId) {
        throw routeError(`Primary teacher is required for ${courseId}`, 400, "TEACHER_REQUIRED");
      }

      const preservedTeachers = existingClass
        ? await getGroupTeacherSummaries(existingClass.id, schoolId)
        : [];
      const preservedCoTeachers = preservedTeachers
        .filter((entry) => entry.relationshipRole === "co-teacher")
        .map((entry) => entry.teacherId);
      const coTeacherIds = await validateTeachers(
        primaryTeacherId,
        requestedCoTeacherIds === undefined ? preservedCoTeachers : requestedCoTeacherIds,
        schoolId
      );

      try {
        courseMeta = courseMeta ?? await getCourseMetadata(classroom, courseId, selected);
        const name = String(courseMeta.name || selected.googleCourseId || "").trim();
        if (!name) throw routeError("Google Classroom course name is required", 400, "CLASS_NAME_REQUIRED");
        const googleStudents = await listCourseStudents(classroom, courseId);
        totalFound += googleStudents.length;

        const gradeLevel = selected.gradeLevel === undefined
          ? existingClass?.gradeLevel || null
          : selected.gradeLevel;
        const course = await upsertClassroomCourse({
          schoolId,
          googleCourseId: courseId,
          name,
          section: courseMeta.section || null,
          room: courseMeta.room || null,
          descriptionHeading: courseMeta.descriptionHeading || null,
          ownerId: courseMeta.ownerId || null,
          lastSyncedAt: new Date(),
        });

        let imported = 0;
        let updated = 0;
        let restored = 0;
        let skipped = 0;
        const studentIds: string[] = [];
        const courseStudentRows: Array<{
          schoolId: string;
          courseId: string;
          studentId: string;
          googleUserId?: string | null;
          studentEmailLc?: string | null;
          lastSeenAt: Date;
        }> = [];

        for (const googleStudent of googleStudents) {
          try {
            const result = await upsertStudentFromClassroom(schoolId, googleStudent, {
              gradeLevel,
              rules,
              autoGenerateClassPilotPins,
              usedPins,
              actor: lifecycleActor,
            });
            if (result.status === "imported") {
              imported++;
              if (result.generatedPin) generatedPins.push(result.generatedPin);
            } else if (result.status === "updated") {
              updated++;
              if (result.restored) restored++;
            } else {
              skipped++;
            }
            if (result.studentId) {
              studentIds.push(result.studentId);
              courseStudentRows.push({
                schoolId,
                courseId: course.id,
                studentId: result.studentId,
                googleUserId: result.googleUserId || null,
                studentEmailLc: result.emailLc || null,
                lastSeenAt: new Date(),
              });
            }
          } catch (error: any) {
            skipped++;
            const email = googleStudent.profile?.emailAddress || googleStudent.userId || "unknown student";
            failures.push(`${email}: ${error?.code || "CLASSROOM_STUDENT_IMPORT_FAILED"}: ${error?.message || "Could not import Classroom student."}`);
          }
        }

        const schedule = await validateSchedule({
          schoolId,
          teacherId: primaryTeacherId,
          scheduleEnabled: existingClass?.scheduleEnabled === true,
          blockStartTime: existingClass?.blockStartTime,
          blockEndTime: existingClass?.blockEndTime,
          excludeGroupId: existingClass?.id,
        });
        if (existingClass) {
          await freezeScheduledOccurrenceIfDue({ group: existingClass });
        }
        const { group, roster } = await upsertAdminClassroomClass({
          schoolId,
          existingGroupId: existingClass?.id || null,
          data: {
            schoolId,
            teacherId: primaryTeacherId,
            name,
            description: existingClass?.description || null,
            periodLabel: selected.periodLabel !== undefined
              ? selected.periodLabel
              : (courseMeta.section || existingClass?.periodLabel || null),
            gradeLevel,
            groupType: "admin_class",
            status: existingClass?.status || "active",
            schoolYear: selected.schoolYear === undefined ? existingClass?.schoolYear || null : selected.schoolYear,
            term: selected.term === undefined ? existingClass?.term || null : selected.term,
            googleClassroomCourseId: courseId,
            scheduleEnabled: existingClass?.scheduleEnabled === true,
            blockStartTime: schedule.blockStartTime,
            blockEndTime: schedule.blockEndTime,
            scheduleSkippedDate: existingClass?.scheduleSkippedDate ?? null,
          },
          primaryTeacherId,
          coTeacherIds,
          studentIds,
          scheduleChangeActorId: req.authUser!.id,
        });
        await upsertClassroomCourseStudents(courseStudentRows);

        if (existingClass) updatedCourses++;
        else importedCourses++;
        totalImported += imported;
        totalUpdated += updated;
        totalRestored += restored;
        totalSkipped += skipped;
        results.push({
          googleCourseId: courseId,
          classId: group.id,
          courseName: name,
          action: existingClass ? "updated" : "created",
          studentsFound: googleStudents.length,
          studentsImported: imported,
          studentsUpdated: updated,
          studentsRestored: restored,
          studentsSkipped: skipped,
          rosterAdded: roster.added.length,
          rosterAlreadyPresent: roster.alreadyPresent.length,
        });
        await logAudit({
          ...actor(req, res),
          action: "class.classroom_import",
          entityType: "class",
          entityId: group.id,
          entityName: group.name,
          changes: {
            action: existingClass ? "updated" : "created",
            googleCourseId: courseId,
            studentsImported: imported,
            studentsUpdated: updated,
            studentsRestored: restored,
            rosterAdded: roster.added.length,
            rosterAlreadyPresent: roster.alreadyPresent.length,
          },
        });
      } catch (error: any) {
        failures.push(`course ${courseId}: ${error?.code || "CLASSROOM_IMPORT_FAILED"}: ${error?.message || "Could not import course."}`);
        results.push({ googleCourseId: courseId, error: error?.message || "Could not import course." });
      }
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported + totalRestored);
    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "classroom",
      scope: selectedCourses.map((course) => course.googleCourseId).join(", "),
      totalFound,
      imported: totalImported,
      updated: totalUpdated,
      skipped: totalSkipped,
      failures,
    });
    await recordRosterConnectorSync(schoolId);

    return res.json({
      importedCourses,
      updatedCourses,
      totalFound,
      totalImported,
      totalUpdated,
      totalRestored,
      totalSkipped,
      failures,
      results,
      autoAssigned,
      generatedPins,
    });
  } catch (err) {
    next(normalizeGoogleClassroomError(err));
  }
});

router.post("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const name = String(req.body.name || "").trim();
    if (!name) throw routeError("Class name is required", 400, "NAME_REQUIRED");
    const primaryTeacherId = String(req.body.primaryTeacherId || req.body.teacherId || "");
    if (!primaryTeacherId) throw routeError("primaryTeacherId is required", 400, "TEACHER_REQUIRED");
    const coTeacherIds = await validateTeachers(primaryTeacherId, req.body.coTeacherIds, schoolId);
    const scheduleEnabled = req.body.scheduleEnabled === true;
    const schedule = await validateSchedule({
      schoolId,
      teacherId: primaryTeacherId,
      scheduleEnabled,
      blockStartTime: req.body.blockStartTime,
      blockEndTime: req.body.blockEndTime,
    });
    const { group } = await upsertAdminClassroomClass({
      schoolId,
      data: {
        schoolId,
        name,
        description: req.body.description ? String(req.body.description) : null,
        periodLabel: req.body.periodLabel ? String(req.body.periodLabel) : null,
        gradeLevel: normalizeGrade(req.body.gradeLevel),
        groupType: "admin_class",
        status: "active",
        schoolYear: req.body.schoolYear ? String(req.body.schoolYear) : null,
        term: req.body.term ? String(req.body.term) : null,
        scheduleEnabled,
        blockStartTime: schedule.blockStartTime,
        blockEndTime: schedule.blockEndTime,
      },
      primaryTeacherId,
      coTeacherIds,
      studentIds: [],
      scheduleChangeActorId: req.authUser!.id,
    });
    await logAudit({
      ...actor(req, res),
      action: "class.create",
      entityType: "class",
      entityId: group.id,
      entityName: group.name,
      changes: { after: group, coTeacherIds },
    });
    return res.status(201).json({ class: await serializeClass(group, schoolId) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/students", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    const students = (await getGroupStudents(group.id)).map((row) => ({
      id: row.student.id,
      studentName: [row.student.firstName, row.student.lastName].filter(Boolean).join(" ") || row.student.email || "",
      studentEmail: row.student.email || "",
      gradeLevel: row.student.gradeLevel || null,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      email: row.student.email,
    }));
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    await freezeScheduledOccurrenceIfDue({ group });
    const submittedName = req.body.name === undefined
      ? undefined
      : String(req.body.name || "").trim();
    if (submittedName !== undefined && !submittedName) {
      throw routeError("Class name is required", 400, "NAME_REQUIRED");
    }
    const submittedPrimaryTeacherId = req.body.primaryTeacherId !== undefined
      ? String(req.body.primaryTeacherId || "")
      : req.body.teacherId !== undefined
        ? String(req.body.teacherId || "")
        : undefined;
    const primaryTeacherId = submittedPrimaryTeacherId ?? group.teacherId;
    const coTeacherIds = req.body.coTeacherIds === undefined
      ? undefined
      : await validateTeachers(primaryTeacherId, req.body.coTeacherIds, schoolId);
    if (submittedPrimaryTeacherId !== undefined && coTeacherIds === undefined) {
      await validateTeachers(submittedPrimaryTeacherId, [], schoolId);
    }
    const scheduleFieldsSubmitted =
      req.body.scheduleEnabled !== undefined ||
      req.body.blockStartTime !== undefined ||
      req.body.blockEndTime !== undefined;
    const scheduleEnabled = req.body.scheduleEnabled === undefined
      ? group.scheduleEnabled
      : req.body.scheduleEnabled === true;
    const schedule = submittedPrimaryTeacherId !== undefined || scheduleFieldsSubmitted
      ? await validateSchedule({
          schoolId,
          teacherId: primaryTeacherId,
          scheduleEnabled,
          blockStartTime: req.body.blockStartTime ?? group.blockStartTime,
          blockEndTime: req.body.blockEndTime ?? group.blockEndTime,
          excludeGroupId: group.id,
        })
      : null;
    const recurringScheduleChanged = Boolean(
      scheduleFieldsSubmitted &&
      schedule &&
      (group.scheduleEnabled !== scheduleEnabled ||
        group.blockStartTime !== schedule.blockStartTime ||
        group.blockEndTime !== schedule.blockEndTime)
    );
    const data: Parameters<typeof updateAdminClassWithTeachers>[0]["data"] = {};
    if (submittedName !== undefined) data.name = submittedName;
    if (req.body.description !== undefined) {
      data.description = req.body.description ? String(req.body.description) : null;
    }
    if (req.body.periodLabel !== undefined) {
      data.periodLabel = req.body.periodLabel ? String(req.body.periodLabel) : null;
    }
    if (req.body.gradeLevel !== undefined) data.gradeLevel = normalizeGrade(req.body.gradeLevel);
    if (req.body.schoolYear !== undefined) {
      data.schoolYear = req.body.schoolYear ? String(req.body.schoolYear) : null;
    }
    if (req.body.term !== undefined) data.term = req.body.term ? String(req.body.term) : null;
    if (scheduleFieldsSubmitted && schedule) {
      data.scheduleEnabled = scheduleEnabled;
      data.blockStartTime = schedule.blockStartTime;
      data.blockEndTime = schedule.blockEndTime;
      if (recurringScheduleChanged) data.scheduleSkippedDate = null;
    }
    const updated = await updateAdminClassWithTeachers({
      groupId: group.id,
      data,
      primaryTeacherId: submittedPrimaryTeacherId,
      coTeacherIds,
      scheduleChangeActorId: req.authUser!.id,
    });
    if (!updated) {
      return res.status(404).json({ error: "Class not found" });
    }
    await logAudit({
      ...actor(req, res),
      action: "class.update",
      entityType: "class",
      entityId: group.id,
      entityName: updated.name,
      changes: { before: group, after: updated, coTeacherIds },
    });
    if (submittedPrimaryTeacherId !== undefined && primaryTeacherId !== group.teacherId) {
      await logAudit({
        ...actor(req, res),
        action: "class.primary_teacher_change",
        entityType: "class",
        entityId: group.id,
        entityName: updated.name,
        changes: { before: group.teacherId, after: primaryTeacherId },
      });
    }
    if (
      recurringScheduleChanged
    ) {
      await logAudit({
        ...actor(req, res),
        action: "class.recurring_schedule_updated",
        entityType: "class",
        entityId: group.id,
        entityName: updated.name,
        changes: {
          before: { scheduleEnabled: group.scheduleEnabled, blockStartTime: group.blockStartTime, blockEndTime: group.blockEndTime },
          after: {
            scheduleEnabled: updated.scheduleEnabled,
            blockStartTime: updated.blockStartTime,
            blockEndTime: updated.blockEndTime,
          },
        },
      });
    }
    return res.json({ class: await serializeClass(updated, schoolId) });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/students", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    await freezeScheduledOccurrenceIfDue({ group });
    if (!Array.isArray(req.body.studentIds)) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    const requested: string[] = Array.from(new Set(req.body.studentIds.map((id: unknown) => String(id))));
    const students = await getStudentsByIds(requested);
    const validIds = students
      .filter((student) => student.schoolId === schoolId && student.status === "active")
      .map((student) => student.id);
    const result = await addGroupStudentsDetailed(group.id, validIds, req.authUser!.id);
    const resultIds = new Set([...result.added, ...result.alreadyPresent]);
    const failed = requested
      .filter((id) => !resultIds.has(id))
      .map((studentId) => ({ studentId, error: "Student not found in this school" }));
    await logAudit({
      ...actor(req, res),
      action: "class.roster_add",
      entityType: "class",
      entityId: group.id,
      entityName: group.name,
      changes: { added: result.added.length, alreadyPresent: result.alreadyPresent.length, failed: failed.length },
      metadata: { addedStudentIds: result.added, alreadyPresentStudentIds: result.alreadyPresent, failed },
    });
    return res.json({
      added: result.added.length,
      alreadyPresent: result.alreadyPresent.length,
      failed,
      addedStudentIds: result.added,
      alreadyPresentStudentIds: result.alreadyPresent,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/students/:studentId", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    await freezeScheduledOccurrenceIfDue({ group });
    await removeGroupStudent(group.id, param(req, "studentId"));
    await logAudit({
      ...actor(req, res),
      action: "class.roster_remove",
      entityType: "class",
      entityId: group.id,
      entityName: group.name,
      metadata: { studentId: param(req, "studentId") },
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/archive", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    await freezeScheduledOccurrenceIfDue({ group });
    const archived = await archiveGroup(group.id, req.authUser!.id);
    if (!archived) {
      return res.status(404).json({ error: "Class not found" });
    }
    await logAudit({
      ...actor(req, res),
      action: "class.archive",
      entityType: "class",
      entityId: group.id,
      entityName: group.name,
      changes: { before: group.status, after: "archived" },
    });
    return res.json({ class: await serializeClass(archived, schoolId) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "id"), schoolId);
    if (!group || group.groupType !== "admin_class") {
      return res.status(404).json({ error: "Class not found" });
    }
    const frozenOccurrence = await freezeScheduledOccurrenceIfDue({ group });
    if (frozenOccurrence) {
      return res.status(409).json({
        error: "This scheduled class is currently active. End or archive it instead of deleting it.",
        code: "ACTIVE_SCHEDULED_OCCURRENCE",
      });
    }
    if (await groupHasTeachingHistory(group.id)) {
      return res.status(409).json({
        error: "Classes with teaching history must be archived instead of deleted.",
        code: "CLASS_HAS_HISTORY",
      });
    }
    await hardDeleteGroupWithCleanup(group.id, req.authUser!.id);
    await logAudit({
      ...actor(req, res),
      action: "class.delete",
      entityType: "class",
      entityId: group.id,
      entityName: group.name,
      changes: { before: group },
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
