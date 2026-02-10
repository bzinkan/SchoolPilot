import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  createStudent,
  searchStudents,
  updateStudent,
} from "../../services/storage.js";

const router = Router();

const auth = [authenticate, requireSchoolContext] as const;

async function getAuthedClient(userId: string) {
  const token = await getGoogleOAuthToken(userId);
  if (!token) throw new Error("Google not connected");

  const { google } = require("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: token.refreshToken });
  return { oauth2Client, google };
}

// GET /api/google/courses - List Google Classroom courses
router.get("/courses", ...auth, async (req, res, next) => {
  try {
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    const response = await classroom.courses.list({
      teacherId: "me",
      courseStates: ["ACTIVE"],
    });

    return res.json({ courses: response.data.courses || [] });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
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
    const results: unknown[] = [];

    for (const course of courses) {
      const { courseId, grade } = course;
      try {
        const studentsRes = await classroom.courses.students.list({ courseId });
        const googleStudents = studentsRes.data.students || [];

        let imported = 0;
        for (const gs of googleStudents) {
          const email = gs.profile?.emailAddress;
          const firstName = gs.profile?.name?.givenName || "";
          const lastName = gs.profile?.name?.familyName || "";

          if (!email) continue;

          const existing = await searchStudents(schoolId, { search: email });
          if (existing.length > 0) {
            // Update if needed
            const existingStudent = existing[0];
            if (grade && existingStudent) {
              await updateStudent(existingStudent.id, { gradeLevel: grade });
            }
          } else {
            await createStudent({
              schoolId,
              firstName,
              lastName,
              email,
              gradeLevel: grade || undefined,
              googleUserId: gs.userId || undefined,
              status: "active",
            });
            imported++;
          }
        }

        totalImported += imported;
        results.push({ courseId, total: googleStudents.length, imported });
      } catch (error: any) {
        results.push({ courseId, error: error.message });
      }
    }

    return res.json({ totalImported, results });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

// POST /api/google/courses/:courseId/sync - Sync a single course (PassPilot)
router.post("/courses/:courseId/sync", ...auth, async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId ?? "");
    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const classroom = google.classroom({ version: "v1", auth: oauth2Client });

    const studentsRes = await classroom.courses.students.list({ courseId });
    const googleStudents = studentsRes.data.students || [];

    let imported = 0;
    for (const gs of googleStudents) {
      const email = gs.profile?.emailAddress;
      const firstName = gs.profile?.name?.givenName || "";
      const lastName = gs.profile?.name?.familyName || "";
      if (!email) continue;

      const existing = await searchStudents(schoolId, { search: email });
      if (existing.length === 0) {
        await createStudent({
          schoolId,
          firstName,
          lastName,
          email,
          googleUserId: gs.userId || undefined,
          status: "active",
        });
        imported++;
      }
    }

    return res.json({ courseId, total: googleStudents.length, imported });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

export default router;
