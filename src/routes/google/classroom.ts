import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  createStudent,
  getStudentByEmail,
  updateStudent,
  getProductLicenses,
  autoAssignFamilyGroups,
  getClassroomCoursesBySchool,
  upsertClassroomCourse,
} from "../../services/storage.js";
import { recordImportRun } from "../../services/importLog.js";

const router = Router();

const auth = [authenticate, requireSchoolContext] as const;
const CLASSROOM_EMAIL_SCOPE = "https://www.googleapis.com/auth/classroom.profile.emails";
const CLASSROOM_RESOURCE_SCOPES = [
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
];

function routeError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function getAuthedClient(userId: string) {
  const token = await getGoogleOAuthToken(userId);
  if (!token) throw routeError("NO_TOKENS: Google not connected");
  if (token.scope && !token.scope.split(/\s+/).includes(CLASSROOM_EMAIL_SCOPE)) {
    throw routeError(
      "MISSING_GOOGLE_SCOPE: Reconnect Google Classroom to grant roster email access."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: token.refreshToken });
  return { oauth2Client, google };
}

function handleGoogleError(err: any, res: any, next: any) {
  const statusCode = err.code || err.status || err.statusCode;
  if (err.message === "Google not connected") {
    return res.status(400).json({ error: "NO_TOKENS: Google not connected" });
  }
  if (statusCode === 401 || err.message?.includes("invalid_grant")) {
    return res.status(400).json({ error: "NO_TOKENS: Reconnect your Google account" });
  }
  if (statusCode === 403) {
    return res.status(403).json({
      error: "INSUFFICIENT_PERMISSIONS: Google Classroom access was denied. Reconnect Google if resource scopes are missing.",
    });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
}

function ensureClassroomResourceScopes(tokenScope?: string | null) {
  const scopes = new Set((tokenScope || "").split(/\s+/).filter(Boolean));
  const missing = CLASSROOM_RESOURCE_SCOPES.filter((scope) => !scopes.has(scope));
  if (missing.length > 0) {
    throw routeError(
      `MISSING_GOOGLE_SCOPE: Reconnect Google Classroom to grant resource access (${missing.join(", ")}).`
    );
  }
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

async function upsertStudentFromClassroom(
  schoolId: string,
  googleStudent: any,
  options: { gradeLevel?: string | null; homeroomId?: string | null }
): Promise<"imported" | "updated" | "skipped"> {
  const email = googleStudent.profile?.emailAddress?.trim();
  if (!email) return "skipped";

  const emailLc = email.toLowerCase();
  const firstName = googleStudent.profile?.name?.givenName || email.split("@")[0] || "";
  const lastName = googleStudent.profile?.name?.familyName || "";
  const existing = await getStudentByEmail(schoolId, emailLc);

  if (existing) {
    await updateStudent(existing.id, {
      firstName: firstName || existing.firstName,
      lastName: lastName || existing.lastName,
      email,
      googleUserId: googleStudent.userId || existing.googleUserId || undefined,
      ...(options.gradeLevel ? { gradeLevel: options.gradeLevel } : {}),
      ...(options.homeroomId ? { homeroomId: options.homeroomId } : {}),
    });
    return "updated";
  }

  await createStudent({
    schoolId,
    firstName,
    lastName,
    email,
    gradeLevel: options.gradeLevel || undefined,
    homeroomId: options.homeroomId || undefined,
    googleUserId: googleStudent.userId || undefined,
    status: "active",
  });
  return "imported";
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
router.get("/courses", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
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
router.get("/courses/:courseId/resources", ...auth, async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId ?? "");
    const token = await getGoogleOAuthToken(req.authUser!.id);
    ensureClassroomResourceScopes(token?.scope);
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
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
router.post("/sync", ...auth, async (req, res, next) => {
  try {
    const { courses } = req.body;
    if (!Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ error: "courses array required" });
    }

    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFound = 0;
    const results: unknown[] = [];
    const failures: string[] = [];

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
            });
            if (result === "imported") imported++;
            else if (result === "updated") updated++;
            else skipped++;
          } catch {
            skipped++;
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
    return res.json({ totalImported, totalUpdated, results, autoAssigned });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// POST /api/google/courses/:courseId/sync - Sync a single course (PassPilot)
router.post("/courses/:courseId/sync", ...auth, async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId ?? "");
    const schoolId = res.locals.schoolId!;
    const gradeLevel = req.body?.gradeLevel || null;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    const courseMeta = await getCourseMetadata(classroom, courseId);
    const googleStudents = await listCourseStudents(classroom, courseId);

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const gs of googleStudents) {
      try {
        const result = await upsertStudentFromClassroom(schoolId, gs, { gradeLevel });
        if (result === "imported") imported++;
        else if (result === "updated") updated++;
        else skipped++;
      } catch {
        skipped++;
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
    });
    return res.json({
      courseId,
      courseName: courseMeta.name || courseId,
      total: googleStudents.length,
      imported,
      updated,
      skipped,
      autoAssigned,
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

export default router;
