import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  createStudent,
  createUser,
  createMembership,
  searchStudents,
  getUserByEmail,
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

// GET /api/google/workspace/orgunits - List org units
router.get("/orgunits", ...auth, async (req, res, next) => {
  try {
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    const response = await admin.orgunits.list({
      customerId: "my_customer",
    });

    return res.json({ orgUnits: response.data.organizationUnits || [] });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

// GET /api/google/workspace/users - List Workspace users
router.get("/users", ...auth, async (req, res, next) => {
  try {
    const { orgUnitPath, pageToken } = req.query;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    const params: any = {
      customer: "my_customer",
      maxResults: 100,
    };
    if (orgUnitPath) params.query = `orgUnitPath='${orgUnitPath}'`;
    if (pageToken) params.pageToken = pageToken;

    const response = await admin.users.list(params);

    return res.json({
      users: (response.data.users || []).map((u: any) => ({
        id: u.id,
        email: u.primaryEmail,
        firstName: u.name?.givenName || "",
        lastName: u.name?.familyName || "",
        orgUnitPath: u.orgUnitPath,
        suspended: u.suspended,
      })),
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

// POST /api/google/workspace/import - Import selected users as students
router.post("/import", ...auth, async (req, res, next) => {
  try {
    const { users, grade } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array required" });
    }

    const schoolId = res.locals.schoolId!;
    let imported = 0;
    let updated = 0;

    for (const u of users) {
      const existing = await searchStudents(schoolId, { search: u.email });
      if (existing.length > 0) {
        updated++;
      } else {
        await createStudent({
          schoolId,
          firstName: u.firstName || u.email.split("@")[0],
          lastName: u.lastName || "",
          email: u.email,
          gradeLevel: grade || u.grade || undefined,
          googleUserId: u.id || undefined,
          status: "active",
        });
        imported++;
      }
    }

    return res.json({ imported, updated, total: users.length });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

// Shared import-staff handler (used by both /import-staff and /import-teachers)
const importStaffHandler = async (req: any, res: any, next: any) => {
  try {
    const { users, role } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array required" });
    }

    const schoolId = res.locals.schoolId!;
    const staffRole = role || "teacher";
    let imported = 0;
    let updated = 0;

    for (const u of users) {
      let user = await getUserByEmail(u.email);
      if (!user) {
        user = await createUser({
          email: u.email,
          firstName: u.firstName || u.email.split("@")[0],
          lastName: u.lastName || "",
          googleId: u.id || null,
        });
        imported++;
      } else {
        updated++;
      }

      // Ensure membership
      const { getMembershipByUserAndSchool } = await import("../../services/storage.js");
      const existing = await getMembershipByUserAndSchool(user.id, schoolId);
      if (!existing) {
        await createMembership({
          userId: user.id,
          schoolId,
          role: staffRole,
          status: "active",
        });
      }
    }

    return res.json({ imported, updated, total: users.length });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
};

// POST /api/google/workspace/import-staff - Import users as staff
router.post("/import-staff", ...auth, importStaffHandler);

// POST /import-teachers - Alias for import-staff (PassPilot compatibility)
router.post("/import-teachers", ...auth, importStaffHandler);

export default router;
