import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { logAudit } from "../../services/audit.js";
import {
  addGroupStudentsDetailed,
  archiveGroup,
  autoAssignFamilyGroups,
  createGroup,
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
  getUserById,
  groupHasTeachingHistory,
  hardDeleteGroupWithCleanup,
  removeGroupStudent,
  replaceGroupTeachers,
  updateStudent,
  updateAdminClassWithTeachers,
  upsertAdminClassroomClass,
  upsertClassroomCourse,
  upsertClassroomCourseStudents,
  validateStaffEmailDomainForSchool,
} from "../../services/storage.js";
import { recordImportRun } from "../../services/importLog.js";
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
  getRosterClassroomClientForSchool,
  recordRosterConnectorSync,
} from "../../services/googleRosterConnector.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

const TEACHABLE_ROLES = new Set(["teacher", "admin", "school_admin"]);
const GRADE_VALUES = new Set(["PK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
const CLASSROOM_IMPORT_ENABLED = process.env.CLASSPILOT_CLASSROOM_IMPORT_ENABLED === "true";
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

async function listActiveCourses(classroom: any) {
  const courses: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await classroom.courses.list({
      teacherId: "me",
      courseStates: ["ACTIVE"],
      pageSize: 100,
      pageToken,
    });
    courses.push(...(response.data.courses || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return courses;
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

type ClassroomStudentUpsertResult = {
  status: "imported" | "updated" | "skipped";
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
    const updated = await updateStudent(existing.id, {
      firstName: firstName || existing.firstName,
      lastName: lastName || existing.lastName,
      email,
      googleUserId: googleStudent.userId || existing.googleUserId || undefined,
      ...(options.gradeLevel ? { gradeLevel: options.gradeLevel } : {}),
    });
    return {
      status: "updated",
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
      return res.json({ enabled: false, courses: [] });
    }
    const schoolId = res.locals.schoolId!;
    const classroom = await getAuthedClassroom(req.authUser!.id, schoolId);
    const existing = await getAdminClassSummariesBySchool(schoolId, { status: "all" });
    const existingByGoogleId = new Map(existing.filter((row) => row.googleClassroomCourseId).map((row) => [row.googleClassroomCourseId, row]));
    let defaultTeacher: ReturnType<typeof teacherPreview> | null = null;
    try {
      defaultTeacher = teacherPreview(await validateTeachableUser(req.authUser!.id, schoolId));
    } catch {
      defaultTeacher = null;
    }
    const courses = await listActiveCourses(classroom);
    const normalized = await Promise.all(courses.map(async (course: any) => {
      const students = await listCourseStudents(classroom, course.id);
      const existingClass = existingByGoogleId.get(course.id);
      let matchedTeacher = defaultTeacher;
      if (existingClass) {
        const teachers = await getGroupTeacherSummaries(existingClass.id, schoolId);
        matchedTeacher = teachers.find((entry) => entry.relationshipRole === "primary")?.teacher || matchedTeacher;
      }
      return {
        googleCourseId: course.id,
        name: course.name || `Class ${course.id}`,
        section: course.section || null,
        matchedTeacher,
        studentCount: students.length,
        existingClassId: existingClass?.id || null,
        importability: existingClass ? "update" : matchedTeacher ? "ready" : "needs_teacher",
      };
    }));
    return res.json({ enabled: true, courses: normalized });
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
    let defaultTeacherId = "";
    try {
      defaultTeacherId = (await validateTeachableUser(req.authUser!.id, schoolId)).user.id;
    } catch {
      defaultTeacherId = "";
    }

    const rules = await studentEmailRules(schoolId);
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const usedPins = new Set<string>();
    const generatedPins: GeneratedClassPilotPin[] = [];
    const failures: string[] = [];
    const results: any[] = [];
    let totalFound = 0;
    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let importedCourses = 0;
    let updatedCourses = 0;

    for (const selected of selectedCourses) {
      const courseId = selected.googleCourseId;
      const existingClass = existingByGoogleId.get(courseId);
      const primaryTeacherId = selected.primaryTeacherId || existingClass?.teacherId || defaultTeacherId;
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
        selected.coTeacherIds === undefined ? preservedCoTeachers : selected.coTeacherIds,
        schoolId
      );

      try {
        const courseMeta = await getCourseMetadata(classroom, courseId, selected);
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
            });
            if (result.status === "imported") {
              imported++;
              if (result.generatedPin) generatedPins.push(result.generatedPin);
            } else if (result.status === "updated") {
              updated++;
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
            scheduleSkippedDate: null,
          },
          primaryTeacherId,
          coTeacherIds,
          studentIds,
        });
        await upsertClassroomCourseStudents(courseStudentRows);

        if (existingClass) updatedCourses++;
        else importedCourses++;
        totalImported += imported;
        totalUpdated += updated;
        totalSkipped += skipped;
        results.push({
          googleCourseId: courseId,
          classId: group.id,
          courseName: name,
          action: existingClass ? "updated" : "created",
          studentsFound: googleStudents.length,
          studentsImported: imported,
          studentsUpdated: updated,
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
            rosterAdded: roster.added.length,
            rosterAlreadyPresent: roster.alreadyPresent.length,
          },
        });
      } catch (error: any) {
        failures.push(`course ${courseId}: ${error?.code || "CLASSROOM_IMPORT_FAILED"}: ${error?.message || "Could not import course."}`);
        results.push({ googleCourseId: courseId, error: error?.message || "Could not import course." });
      }
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported);
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
    const group = await createGroup({
      schoolId,
      teacherId: primaryTeacherId,
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
    });
    await replaceGroupTeachers(group.id, primaryTeacherId, coTeacherIds);
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
    const name = req.body.name === undefined ? group.name : String(req.body.name || "").trim();
    if (!name) throw routeError("Class name is required", 400, "NAME_REQUIRED");
    const primaryTeacherId = String(req.body.primaryTeacherId || req.body.teacherId || group.teacherId);
    const existingTeachers = req.body.coTeacherIds === undefined
      ? await getGroupTeacherSummaries(group.id, schoolId)
      : [];
    const coTeacherInput = req.body.coTeacherIds === undefined
      ? existingTeachers
          .filter((entry) => entry.relationshipRole === "co-teacher")
          .map((entry) => entry.teacherId)
      : req.body.coTeacherIds;
    const coTeacherIds = await validateTeachers(primaryTeacherId, coTeacherInput, schoolId);
    const scheduleEnabled = req.body.scheduleEnabled === undefined ? group.scheduleEnabled : req.body.scheduleEnabled === true;
    const schedule = await validateSchedule({
      schoolId,
      teacherId: primaryTeacherId,
      scheduleEnabled,
      blockStartTime: req.body.blockStartTime ?? group.blockStartTime,
      blockEndTime: req.body.blockEndTime ?? group.blockEndTime,
      excludeGroupId: group.id,
    });
    const data = {
      name,
      description: req.body.description === undefined ? group.description : (req.body.description ? String(req.body.description) : null),
      periodLabel: req.body.periodLabel === undefined ? group.periodLabel : (req.body.periodLabel ? String(req.body.periodLabel) : null),
      gradeLevel: req.body.gradeLevel === undefined ? group.gradeLevel : normalizeGrade(req.body.gradeLevel),
      schoolYear: req.body.schoolYear === undefined ? group.schoolYear : (req.body.schoolYear ? String(req.body.schoolYear) : null),
      term: req.body.term === undefined ? group.term : (req.body.term ? String(req.body.term) : null),
      scheduleEnabled,
      blockStartTime: schedule.blockStartTime,
      blockEndTime: schedule.blockEndTime,
      scheduleSkippedDate: null,
    };
    const updated = await updateAdminClassWithTeachers({
      groupId: group.id,
      data,
      primaryTeacherId,
      coTeacherIds,
    });
    if (!updated) {
      return res.status(404).json({ error: "Class not found" });
    }
    await logAudit({
      ...actor(req, res),
      action: "class.update",
      entityType: "class",
      entityId: group.id,
      entityName: name,
      changes: { before: group, after: updated, coTeacherIds },
    });
    if (primaryTeacherId !== group.teacherId) {
      await logAudit({
        ...actor(req, res),
        action: "class.primary_teacher_change",
        entityType: "class",
        entityId: group.id,
        entityName: name,
        changes: { before: group.teacherId, after: primaryTeacherId },
      });
    }
    if (group.scheduleEnabled !== scheduleEnabled || group.blockStartTime !== schedule.blockStartTime || group.blockEndTime !== schedule.blockEndTime) {
      await logAudit({
        ...actor(req, res),
        action: "class.schedule_change",
        entityType: "class",
        entityId: group.id,
        entityName: name,
        changes: {
          before: { scheduleEnabled: group.scheduleEnabled, blockStartTime: group.blockStartTime, blockEndTime: group.blockEndTime },
          after: { scheduleEnabled, blockStartTime: schedule.blockStartTime, blockEndTime: schedule.blockEndTime },
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
    if (!Array.isArray(req.body.studentIds)) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    const requested: string[] = Array.from(new Set(req.body.studentIds.map((id: unknown) => String(id))));
    const students = await getStudentsByIds(requested);
    const validIds = students.filter((student) => student.schoolId === schoolId).map((student) => student.id);
    const result = await addGroupStudentsDetailed(group.id, validIds);
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
    const archived = await archiveGroup(group.id);
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
    if (await groupHasTeachingHistory(group.id)) {
      return res.status(409).json({
        error: "Classes with teaching history must be archived instead of deleted.",
        code: "CLASS_HAS_HISTORY",
      });
    }
    await hardDeleteGroupWithCleanup(group.id);
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
