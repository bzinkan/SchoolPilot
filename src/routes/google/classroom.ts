import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getGoogleOAuthTokenForSchool,
  createStudent,
  getStudentByEmail,
  updateStudent,
  getProductLicenses,
  autoAssignFamilyGroups,
  getClassroomCoursesBySchool,
  upsertClassroomCourse,
} from "../../services/storage.js";
import { recordImportRun } from "../../services/importLog.js";
import {
  checkStudentEmail,
  studentEmailRules,
  studentEmailTaken,
  type StudentEmailRules,
} from "../../services/studentEmailPolicy.js";
import {
  generatedPinForStudent,
  hashClassPilotPin,
  randomFourDigitClassPilotPin,
  type GeneratedClassPilotPin,
} from "../../services/classpilotPins.js";

const router = Router();

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireRole("teacher", "admin", "school_admin"),
] as const;
const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin", "school_admin"),
] as const;
const CLASSROOM_EMAIL_SCOPE = "https://www.googleapis.com/auth/classroom.profile.emails";
const CLASSROOM_COURSES_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";
const CLASSROOM_ROSTER_SCOPES = [
  CLASSROOM_COURSES_SCOPE,
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  CLASSROOM_EMAIL_SCOPE,
];
const CLASSROOM_RESOURCE_SCOPES = [
  CLASSROOM_COURSES_SCOPE,
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
];

function routeError(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function ensureScopes(tokenScope: string | null | undefined, requiredScopes: string[], label: string) {
  const scopes = new Set((tokenScope || "").split(/\s+/).filter(Boolean));
  const missing = requiredScopes.filter((scope) => !scopes.has(scope));
  if (missing.length > 0) {
    throw routeError(
      `MISSING_GOOGLE_SCOPE: Reconnect Google Classroom to grant ${label} access (${missing.join(", ")}).`,
      400,
      "MISSING_GOOGLE_SCOPE"
    );
  }
}

async function getAuthedClient(userId: string, schoolId: string, requiredScopes: string[], label: string) {
  const token = await getGoogleOAuthTokenForSchool(userId, schoolId);
  if (!token) throw routeError("NO_TOKENS: Google not connected for this school");
  ensureScopes(token.scope, requiredScopes, label);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: token.refreshToken });
  return { oauth2Client, google };
}

function handleGoogleError(err: any, res: any, next: any) {
  const statusCode = err.code || err.status || err.statusCode;
  if (err.code && typeof err.code === "string") {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err.message === "Google not connected") {
    return res.status(400).json({ error: "NO_TOKENS: Google not connected", code: "NO_TOKENS" });
  }
  if (statusCode === 401 || err.message?.includes("invalid_grant")) {
    return res.status(400).json({ error: "NO_TOKENS: Reconnect your Google account", code: "NO_TOKENS" });
  }
  if (statusCode === 403) {
    return res.status(403).json({
      error: "INSUFFICIENT_PERMISSIONS: Google Classroom access was denied. Reconnect Google if resource scopes are missing.",
      code: "INSUFFICIENT_PERMISSIONS",
    });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
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

function normalizeMaterialLinks(materials: any[] | undefined): Array<{ type: string; title: string | null; url: string }> {
  const links: Array<{ type: string; title: string | null; url: string }> = [];
  for (const material of materials || []) {
    if (material.link?.url) {
      links.push({ type: "link", title: material.link.title || null, url: material.link.url });
    }
    if (material.youtubeVideo) {
      const video = material.youtubeVideo;
      const url = video.id ? `https://www.youtube.com/watch?v=${video.id}` : video.alternateLink;
      if (url) links.push({ type: "youtube", title: video.title || null, url });
    }
    if (material.driveFile?.driveFile?.alternateLink) {
      links.push({
        type: "drive",
        title: material.driveFile.driveFile.title || null,
        url: material.driveFile.driveFile.alternateLink,
      });
    }
    if (material.form?.formUrl) {
      links.push({ type: "form", title: material.form.title || null, url: material.form.formUrl });
    }
  }
  return links;
}

async function listCourseWork(classroom: any, courseId: string) {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await classroom.courses.courseWork.list({
      courseId,
      pageSize: 100,
      pageToken,
    });
    items.push(...(response.data.courseWork || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return items;
}

async function listCourseMaterials(classroom: any, courseId: string) {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await classroom.courses.courseWorkMaterials.list({
      courseId,
      pageSize: 100,
      pageToken,
    });
    items.push(...(response.data.courseWorkMaterial || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return items;
}

async function maybeAutoAssignGoPilotFamilies(schoolId: string, imported: number) {
  if (imported === 0) return undefined;
  const licenses = await getProductLicenses(schoolId);
  const hasGoPilot = licenses.some(
    (license) => license.product === "GOPILOT" && license.status === "active"
  );
  return hasGoPilot ? autoAssignFamilyGroups(schoolId) : undefined;
}

async function hasActiveClassPilotLicense(schoolId: string): Promise<boolean> {
  const licenses = await getProductLicenses(schoolId);
  return licenses.some(
    (license) => license.product === "CLASSPILOT" && license.status === "active"
  );
}

type ClassroomStudentUpsertResult = {
  status: "imported" | "updated" | "skipped";
  generatedPin?: GeneratedClassPilotPin;
};

async function upsertStudentFromClassroom(
  schoolId: string,
  googleStudent: any,
  options: {
    gradeLevel?: string | null;
    homeroomId?: string | null;
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
    await updateStudent(existing.id, {
      firstName: firstName || existing.firstName,
      lastName: lastName || existing.lastName,
      email,
      googleUserId: googleStudent.userId || existing.googleUserId || undefined,
      ...(options.gradeLevel ? { gradeLevel: options.gradeLevel } : {}),
      ...(options.homeroomId ? { homeroomId: options.homeroomId } : {}),
    });
    return { status: "updated" };
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
    homeroomId: options.homeroomId || undefined,
    googleUserId: googleStudent.userId || undefined,
    classpilotPinHash: pin ? await hashClassPilotPin(pin) : undefined,
    status: "active",
  });
  return {
    status: "imported",
    generatedPin: pin ? generatedPinForStudent(student, pin) : undefined,
  };
}

async function getCourseMetadata(classroom: any, courseId: string, fallback?: any) {
  try {
    const response = await classroom.courses.get({ id: courseId });
    return response.data || fallback || {};
  } catch {
    return fallback || {};
  }
}

async function recordCourseSync(schoolId: string, courseId: string, course: any) {
  await upsertClassroomCourse({
    schoolId,
    googleCourseId: courseId,
    name: course.name || course.courseName || `Class ${courseId}`,
    section: course.section || null,
    room: course.room || null,
    descriptionHeading: course.descriptionHeading || null,
    ownerId: course.ownerId || null,
    lastSyncedAt: new Date(),
  });
}

// GET /api/google/courses - List Google Classroom courses
router.get("/courses", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(
      req.authUser!.id,
      res.locals.schoolId!,
      [CLASSROOM_COURSES_SCOPE],
      "course"
    );
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });
    const courses = await listActiveCourses(classroom);
    const savedCourses = await getClassroomCoursesBySchool(schoolId);
    const savedByGoogleId = new Map(savedCourses.map((course) => [course.googleCourseId, course]));

    return res.json({
      courses: courses.map((course) => ({
        ...course,
        lastSyncedAt: savedByGoogleId.get(course.id || "")?.lastSyncedAt || null,
      })),
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// GET /api/google/classroom/courses/:courseId/resources
router.get("/courses/:courseId/resources", ...staffAuth, async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId ?? "");
    const { oauth2Client, google } = await getAuthedClient(
      req.authUser!.id,
      res.locals.schoolId!,
      CLASSROOM_RESOURCE_SCOPES,
      "resource"
    );
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });
    const [course, courseWork, materials] = await Promise.all([
      getCourseMetadata(classroom, courseId),
      listCourseWork(classroom, courseId),
      listCourseMaterials(classroom, courseId),
    ]);

    const resources = [
      ...courseWork.map((item) => ({
        id: item.id,
        resourceType: "coursework",
        title: item.title || "Untitled assignment",
        description: item.description || null,
        state: item.state || null,
        updateTime: item.updateTime || null,
        dueDate: item.dueDate || null,
        links: [
          ...(item.alternateLink ? [{ type: "classroom", title: "Classroom assignment", url: item.alternateLink }] : []),
          ...normalizeMaterialLinks(item.materials),
        ],
      })),
      ...materials.map((item) => ({
        id: item.id,
        resourceType: "material",
        title: item.title || "Untitled material",
        description: item.description || null,
        state: item.state || null,
        updateTime: item.updateTime || null,
        dueDate: null,
        links: [
          ...(item.alternateLink ? [{ type: "classroom", title: "Classroom material", url: item.alternateLink }] : []),
          ...normalizeMaterialLinks(item.materials),
        ],
      })),
    ];

    return res.json({
      course: { id: courseId, name: course.name || course.courseName || courseId, section: course.section || null },
      resources,
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// POST /api/google/sync - Sync Google Classroom roster
router.post("/sync", ...adminAuth, async (req, res, next) => {
  try {
    const { courses } = req.body;
    if (!Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ error: "courses array required" });
    }

    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(
      req.authUser!.id,
      res.locals.schoolId!,
      CLASSROOM_ROSTER_SCOPES,
      "roster"
    );
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFound = 0;
    const results: unknown[] = [];
    const failures: string[] = [];
    const rules = await studentEmailRules(schoolId);
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const generatedPins: GeneratedClassPilotPin[] = [];
    const usedPins = new Set<string>();

    for (const course of courses) {
      const { courseId, grade, gradeLevel, homeroomId } = course;
      try {
        const courseMeta = await getCourseMetadata(classroom, courseId, course);
        const googleStudents = await listCourseStudents(classroom, courseId);
        totalFound += googleStudents.length;

        let imported = 0;
        let updated = 0;
        let skipped = 0;
        for (const gs of googleStudents) {
          // Per-student try/catch so one bad roster row doesn't abort the
          // rest of the course's students.
          try {
            const result = await upsertStudentFromClassroom(schoolId, gs, {
              gradeLevel: gradeLevel || grade || null,
              homeroomId: homeroomId || null,
              rules,
              autoGenerateClassPilotPins,
              usedPins,
            });
            if (result.status === "imported") {
              imported++;
              if (result.generatedPin) generatedPins.push(result.generatedPin);
            }
            else if (result.status === "updated") updated++;
            else skipped++;
          } catch (error: any) {
            skipped++;
            const email = gs.profile?.emailAddress || gs.userId || "unknown student";
            failures.push(`${email}: ${error?.code || "CLASSROOM_STUDENT_IMPORT_FAILED"}: ${error?.message || "Could not import Classroom student."}`);
          }
        }

        await recordCourseSync(schoolId, courseId, courseMeta);
        totalImported += imported;
        totalUpdated += updated;
        totalSkipped += skipped;
        results.push({
          courseId,
          courseName: courseMeta.name || course.courseName || courseId,
          total: googleStudents.length,
          imported,
          updated,
          skipped,
          studentsFound: googleStudents.length,
          studentsImported: imported,
        });
      } catch (error: any) {
        failures.push(`course ${courseId}: ${error.message}`);
        results.push({ courseId, error: error.message });
      }
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported);

    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "classroom",
      scope: courses.map((c: any) => c.courseId).filter(Boolean).join(", "),
      totalFound,
      imported: totalImported,
      updated: totalUpdated,
      skipped: totalSkipped,
      failures,
    });
    return res.json({ totalImported, totalUpdated, results, autoAssigned, generatedPins });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// POST /api/google/courses/:courseId/sync - Sync a single course (PassPilot)
router.post("/courses/:courseId/sync", ...adminAuth, async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId ?? "");
    const schoolId = res.locals.schoolId!;
    const gradeLevel = req.body?.gradeLevel || null;
    const { oauth2Client, google } = await getAuthedClient(
      req.authUser!.id,
      res.locals.schoolId!,
      CLASSROOM_ROSTER_SCOPES,
      "roster"
    );
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    const courseMeta = await getCourseMetadata(classroom, courseId);
    const googleStudents = await listCourseStudents(classroom, courseId);
    const rules = await studentEmailRules(schoolId);

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const failures: string[] = [];
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const generatedPins: GeneratedClassPilotPin[] = [];
    const usedPins = new Set<string>();
    for (const gs of googleStudents) {
      try {
        const result = await upsertStudentFromClassroom(schoolId, gs, {
          gradeLevel,
          rules,
          autoGenerateClassPilotPins,
          usedPins,
        });
        if (result.status === "imported") {
          imported++;
          if (result.generatedPin) generatedPins.push(result.generatedPin);
        }
        else if (result.status === "updated") updated++;
        else skipped++;
      } catch (error: any) {
        skipped++;
        const email = gs.profile?.emailAddress || gs.userId || "unknown student";
        failures.push(`${email}: ${error?.code || "CLASSROOM_STUDENT_IMPORT_FAILED"}: ${error?.message || "Could not import Classroom student."}`);
      }
    }

    await recordCourseSync(schoolId, courseId, courseMeta);
    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, imported);

    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "classroom",
      scope: courseId,
      totalFound: googleStudents.length,
      imported,
      updated,
      skipped,
      failures,
    });
    return res.json({
      courseId,
      courseName: courseMeta.name || courseId,
      total: googleStudents.length,
      imported,
      updated,
      skipped,
      autoAssigned,
      generatedPins,
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

export default router;
