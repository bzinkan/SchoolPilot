import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  getGoogleOAuthToken,
  createStudent,
  updateStudent,
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

    // Auto-detect grade level from OU name (e.g. "Grade 7", "7th Grade", "8th")
    const orgUnits = (response.data.organizationUnits || []).map((ou: any) => {
      const name = ou.name || "";
      let detectedGrade: string | null = null;
      // Match patterns: "Grade 7", "Grade 8", "grade 12"
      const gradeMatch = name.match(/\bgrade\s+(\d{1,2})\b/i);
      if (gradeMatch) {
        detectedGrade = gradeMatch[1];
      }
      // Match patterns: "7th Grade", "8th grade", "1st grade"
      if (!detectedGrade) {
        const ordinalMatch = name.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*grade?\b/i);
        if (ordinalMatch) detectedGrade = ordinalMatch[1];
      }
      // Match "Kindergarten" or "Pre-K"
      if (!detectedGrade) {
        if (/\bkindergarten\b/i.test(name)) detectedGrade = "K";
        else if (/\bpre-?k\b/i.test(name)) detectedGrade = "PK";
      }
      return { ...ou, detectedGrade };
    });

    return res.json({ orgUnits });
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
// Accepts either:
//   { users: [...], grade } — direct user array (PassPilot)
//   { entries: [{orgUnitPath, gradeLevel, excludeEmails?}] } — OU-based import (ClassPilot)
//   { orgUnitPath, gradeLevel } — single OU import (PassPilot SetupView)
router.post("/import", ...auth, async (req, res, next) => {
  try {
    const { users, grade, entries, orgUnitPath, gradeLevel } = req.body;
    const schoolId = res.locals.schoolId!;

    // OU-based import with entries array (ClassPilot Students page)
    if (Array.isArray(entries) && entries.length > 0) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

      let totalImported = 0;
      let totalUpdated = 0;

      for (const entry of entries) {
        const params: any = { customer: "my_customer", maxResults: 500 };
        if (entry.orgUnitPath && entry.orgUnitPath !== "/") {
          params.query = `orgUnitPath='${entry.orgUnitPath}'`;
        }

        const response = await admin.users.list(params);
        const googleUsers = response.data.users || [];
        const excludeSet = new Set(entry.excludeEmails || []);

        for (const u of googleUsers) {
          if (u.suspended) continue;
          const email = u.primaryEmail;
          if (!email) continue;
          if (excludeSet.has(email)) continue;

          const existing = await searchStudents(schoolId, { search: email });
          if (existing.length > 0) {
            // Update existing student with latest data from Google + grade
            const ex = existing[0]!;
            await updateStudent(ex.id, {
              firstName: u.name?.givenName || ex.firstName,
              lastName: u.name?.familyName || ex.lastName,
              email,
              emailLc: email.toLowerCase(),
              gradeLevel: entry.gradeLevel || ex.gradeLevel || undefined,
              googleUserId: u.id || ex.googleUserId || undefined,
            });
            totalUpdated++;
          } else {
            await createStudent({
              schoolId,
              firstName: u.name?.givenName || email.split("@")[0] || "",
              lastName: u.name?.familyName || "",
              email,
              emailLc: email.toLowerCase(),
              gradeLevel: entry.gradeLevel || undefined,
              googleUserId: u.id || undefined,
              status: "active",
            });
            totalImported++;
          }
        }
      }

      return res.json({ imported: totalImported, updated: totalUpdated });
    }

    // Single OU import (PassPilot SetupView)
    if (orgUnitPath) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

      const params: any = { customer: "my_customer", maxResults: 500 };
      if (orgUnitPath !== "/") {
        params.query = `orgUnitPath='${orgUnitPath}'`;
      }

      const response = await admin.users.list(params);
      const googleUsers = response.data.users || [];
      let imported = 0;
      let updated = 0;

      for (const u of googleUsers) {
        if (u.suspended) continue;
        const email = u.primaryEmail;
        if (!email) continue;

        const existing = await searchStudents(schoolId, { search: email });
        if (existing.length > 0) {
          const ex = existing[0]!;
          await updateStudent(ex.id, {
            firstName: u.name?.givenName || ex.firstName,
            lastName: u.name?.familyName || ex.lastName,
            email,
            emailLc: email.toLowerCase(),
            gradeLevel: gradeLevel || ex.gradeLevel || undefined,
            googleUserId: u.id || ex.googleUserId || undefined,
          });
          updated++;
        } else {
          await createStudent({
            schoolId,
            firstName: u.name?.givenName || email.split("@")[0] || "",
            lastName: u.name?.familyName || "",
            email,
            emailLc: email.toLowerCase(),
            gradeLevel: gradeLevel || undefined,
            googleUserId: u.id || undefined,
            status: "active",
          });
          imported++;
        }
      }

      return res.json({ imported, updated });
    }

    // Direct user array import (PassPilot)
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array, entries array, or orgUnitPath required" });
    }

    let imported = 0;
    let updated = 0;

    for (const u of users) {
      const existing = await searchStudents(schoolId, { search: u.email });
      if (existing.length > 0) {
        const ex = existing[0]!;
        await updateStudent(ex.id, {
          firstName: u.firstName || ex.firstName,
          lastName: u.lastName || ex.lastName,
          email: u.email,
          emailLc: u.email.toLowerCase(),
          gradeLevel: grade || u.grade || ex.gradeLevel || undefined,
          googleUserId: u.id || ex.googleUserId || undefined,
        });
        updated++;
      } else {
        await createStudent({
          schoolId,
          firstName: u.firstName || u.email.split("@")[0],
          lastName: u.lastName || "",
          email: u.email,
          emailLc: u.email.toLowerCase(),
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
// Accepts either:
//   { users: [...], role } — direct user array
//   { orgUnitPath, userIds? } — OU-based import, optionally filtered by userIds
const importStaffHandler = async (req: any, res: any, next: any) => {
  try {
    const { users, role, orgUnitPath, userIds } = req.body;
    const schoolId = res.locals.schoolId!;
    const staffRole = role || "teacher";

    // If orgUnitPath provided, fetch users from Google Directory
    if (orgUnitPath || (orgUnitPath === undefined && !users)) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

      const params: any = { customer: "my_customer", maxResults: 500 };
      if (orgUnitPath && orgUnitPath !== "/") {
        params.query = `orgUnitPath='${orgUnitPath}'`;
      }

      const response = await admin.users.list(params);
      const googleUsers = response.data.users || [];
      const filterIds = userIds ? new Set(userIds) : null;

      let imported = 0;
      let skipped = 0;

      for (const u of googleUsers) {
        if (u.suspended) continue;
        const email = u.primaryEmail;
        if (!email) continue;
        if (filterIds && !filterIds.has(u.id)) continue;

        let user = await getUserByEmail(email);
        if (!user) {
          user = await createUser({
            email,
            firstName: u.name?.givenName || email.split("@")[0],
            lastName: u.name?.familyName || "",
            googleId: u.id || null,
          });
          imported++;
        } else {
          skipped++;
        }

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

      return res.json({ imported, skipped, updated: skipped, total: imported + skipped });
    }

    // Direct user array import
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array or orgUnitPath required" });
    }

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

// POST /api/google/workspace/import-orgunits - Bulk import users from multiple org units
router.post("/import-orgunits", ...auth, async (req, res, next) => {
  try {
    const { orgUnits, grade } = req.body;
    if (!Array.isArray(orgUnits) || orgUnits.length === 0) {
      return res.status(400).json({ error: "orgUnits array required" });
    }

    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    let totalImported = 0;
    let totalUpdated = 0;

    for (const ouPath of orgUnits) {
      const params: any = { customer: "my_customer", maxResults: 500 };
      if (ouPath && ouPath !== "/") {
        params.query = `orgUnitPath='${ouPath}'`;
      }

      const response = await admin.users.list(params);
      const googleUsers = response.data.users || [];

      for (const u of googleUsers) {
        if (u.suspended) continue;
        const email = u.primaryEmail;
        if (!email) continue;

        const existing = await searchStudents(schoolId, { search: email });
        if (existing.length > 0) {
          const ex = existing[0]!;
          await updateStudent(ex.id, {
            firstName: u.name?.givenName || ex.firstName,
            lastName: u.name?.familyName || ex.lastName,
            email,
            emailLc: email.toLowerCase(),
            gradeLevel: grade || ex.gradeLevel || undefined,
            googleUserId: u.id || ex.googleUserId || undefined,
          });
          totalUpdated++;
        } else {
          await createStudent({
            schoolId,
            firstName: u.name?.givenName || email.split("@")[0] || "",
            lastName: u.name?.familyName || "",
            email,
            emailLc: email.toLowerCase(),
            gradeLevel: grade || undefined,
            googleUserId: u.id || undefined,
            status: "active",
          });
          totalImported++;
        }
      }
    }

    return res.json({ imported: totalImported, updated: totalUpdated });
  } catch (err: any) {
    if (err.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected" });
    }
    next(err);
  }
});

// POST /api/google/workspace/import-staff - Import users as staff
router.post("/import-staff", ...auth, importStaffHandler);

// POST /import-teachers - Alias for import-staff (PassPilot compatibility)
router.post("/import-teachers", ...auth, importStaffHandler);

export default router;
