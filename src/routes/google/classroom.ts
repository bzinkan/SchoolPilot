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

const router = Router();

const auth = [authenticate, requireSchoolContext] as const;
const CLASSROOM_EMAIL_SCOPE = "https://www.googleapis.com/auth/classroom.profile.emails";

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
      error: "INSUFFICIENT_PERMISSIONS: Google Classroom roster access was denied.",
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
    const results: unknown[] = [];

    for (const course of courses) {
      const { courseId, grade, gradeLevel, homeroomId } = course;
      try {
        const courseMeta = await getCourseMetadata(classroom, courseId, course);
        const googleStudents = await listCourseStudents(classroom, courseId);

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
        results.push({ courseId, error: error.message });
      }
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported);

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
