import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getGoogleOAuthTokenForSchool,
  createStudent,
  updateStudent,
  createUser,
  createMembership,
  getStudentByEmail,
  getUserByEmail,
  getMembershipByUserAndSchool,
  getProductLicenses,
  getSchoolById,
  normalizeDomain,
  autoAssignFamilyGroups,
} from "../../services/storage.js";
import { recordImportRun } from "../../services/importLog.js";
import {
  checkStudentEmail,
  studentEmailRules,
  studentEmailTaken,
  validateStaffImportEmailForSchool,
} from "../../services/studentEmailPolicy.js";
import {
  encryptClassPilotPin,
  generatedPinForStudent,
  hashClassPilotPin,
  randomFourDigitClassPilotPin,
  type GeneratedClassPilotPin,
} from "../../services/classpilotPins.js";

const router = Router();

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin", "school_admin"),
] as const;

const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
];

// Extract student ID from Google Workspace externalIds field
function extractStudentId(user: any): string | undefined {
  const externalIds = user.externalIds;
  if (!Array.isArray(externalIds) || externalIds.length === 0) return undefined;
  // Prefer "organization" or "account" type, fall back to first entry
  const org = externalIds.find((e: any) => e.type === "organization");
  const acct = externalIds.find((e: any) => e.type === "account");
  const val = org?.value || acct?.value || externalIds[0]?.value;
  return val ? String(val).trim() : undefined;
}

function routeError(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code, expose: true });
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
      error:
        "INSUFFICIENT_PERMISSIONS: Google Workspace administrator directory access is required.",
      code: "INSUFFICIENT_PERMISSIONS",
    });
  }
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
}

function escapeDirectoryQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type DirectoryUsersProjection = "basic" | "full";
type DirectoryUsersSource = "customer" | "domain_fallback";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function buildDirectoryUsersParams(options: {
  orgUnitPath?: string;
  projection?: DirectoryUsersProjection;
  domain?: string | null;
  pageToken?: string;
}) {
  const params: any = {
    maxResults: 500,
    projection: options.projection || "basic",
  };
  if (options.domain) {
    params.domain = options.domain;
  } else {
    params.customer = "my_customer";
  }
  if (options.pageToken) {
    params.pageToken = options.pageToken;
  }
  if (options.orgUnitPath && options.orgUnitPath !== "/") {
    params.query = `orgUnitPath='${escapeDirectoryQueryValue(options.orgUnitPath)}'`;
  }
  return params;
}

function formatImportPolicyError(email: string, err: { code: string; error: string }) {
  return `${email}: ${err.code}: ${err.error}`;
}

async function listDirectoryUsers(admin: any, params: any, paginateAll = true) {
  const users: any[] = [];
  let pageToken = params.pageToken as string | undefined;
  let nextPageToken: string | null = null;

  do {
    const response = await admin.users.list({
      ...params,
      pageToken,
      maxResults: Math.min(Number(params.maxResults || 500), 500),
    });
    users.push(...(response.data.users || []));
    nextPageToken = response.data.nextPageToken || null;
    pageToken = nextPageToken || undefined;
  } while (paginateAll && pageToken);

  return { users, nextPageToken: paginateAll ? null : nextPageToken };
}

async function listDirectoryUsersForSchool(
  admin: any,
  schoolId: string,
  options: {
    orgUnitPath?: string;
    projection?: DirectoryUsersProjection;
    pageToken?: string;
    paginateAll?: boolean;
  } = {}
): Promise<{
  users: any[];
  nextPageToken: string | null;
  source: DirectoryUsersSource;
  customerUserCount: number;
  domainFallbackAttempted: boolean;
  domainUserCount?: number;
  queriedDomain?: string;
}> {
  const paginateAll = options.paginateAll ?? true;
  const customerParams = buildDirectoryUsersParams({
    orgUnitPath: options.orgUnitPath,
    projection: options.projection,
    pageToken: options.pageToken,
  });
  const customerResponse = await listDirectoryUsers(admin, customerParams, paginateAll);

  // A page token belongs to the original customer query, so do not switch query
  // modes mid-pagination.
  if (customerResponse.users.length > 0 || options.pageToken) {
    return {
      ...customerResponse,
      source: "customer",
      customerUserCount: customerResponse.users.length,
      domainFallbackAttempted: false,
    };
  }

  const school = await getSchoolById(schoolId);
  const schoolDomain = normalizeDomain(school?.domain);
  if (!schoolDomain) {
    return {
      ...customerResponse,
      source: "customer",
      customerUserCount: customerResponse.users.length,
      domainFallbackAttempted: false,
    };
  }

  const domainParams = buildDirectoryUsersParams({
    orgUnitPath: options.orgUnitPath,
    projection: options.projection,
    domain: schoolDomain,
  });
  const domainResponse = await listDirectoryUsers(admin, domainParams, paginateAll);

  return {
    ...domainResponse,
    source: "domain_fallback",
    customerUserCount: customerResponse.users.length,
    domainFallbackAttempted: true,
    domainUserCount: domainResponse.users.length,
    queriedDomain: schoolDomain,
  };
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

async function importGoogleUsersAsStudents(
  schoolId: string,
  googleUsers: any[],
  options: { gradeLevel?: string | null; excludeEmails?: string[]; autoGenerateClassPilotPins?: boolean }
) {
  const excludeSet = new Set(
    (options.excludeEmails || []).map((email) => String(email).toLowerCase())
  );
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];
  const generatedPins: GeneratedClassPilotPin[] = [];
  const usedPins = new Set<string>();
  const rules = await studentEmailRules(schoolId);

  for (const u of googleUsers) {
    if (u.suspended || u.isAdmin || u.isDelegatedAdmin) {
      skipped++;
      continue;
    }
    const email = u.primaryEmail?.trim();
    if (!email) {
      skipped++;
      continue;
    }
    const emailLc = email.toLowerCase();
    if (excludeSet.has(emailLc)) {
      skipped++;
      continue;
    }

    const emailErr = checkStudentEmail(email, rules);
    if (emailErr) {
      skipped++;
      errors.push(`${email}: ${emailErr.error}`);
      continue;
    }

    // Per-student try/catch: one bad row (unique-constraint race, malformed
    // data) must NOT abort the whole roster import. Collect the error and
    // continue so the IT admin gets partial success + a clear failure list.
    try {
      const studentIdNumber = extractStudentId(u);
      const existing = await getStudentByEmail(schoolId, emailLc);
      const taken = await studentEmailTaken(schoolId, emailLc, existing?.id);
      if (taken) {
        skipped++;
        errors.push(`${email}: ${taken}`);
        continue;
      }
      if (existing) {
        await updateStudent(existing.id, {
          firstName: u.name?.givenName || existing.firstName,
          lastName: u.name?.familyName || existing.lastName,
          email,
          gradeLevel: options.gradeLevel || existing.gradeLevel || undefined,
          googleUserId: u.id || existing.googleUserId || undefined,
          studentIdNumber: studentIdNumber || existing.studentIdNumber || undefined,
        });
        updated++;
      } else {
        const pin = options.autoGenerateClassPilotPins
          ? randomFourDigitClassPilotPin(usedPins)
          : null;
        const student = await createStudent({
          schoolId,
          firstName: u.name?.givenName || email.split("@")[0] || "",
          lastName: u.name?.familyName || "",
          email,
          gradeLevel: options.gradeLevel || undefined,
          googleUserId: u.id || undefined,
          studentIdNumber: studentIdNumber || undefined,
          classpilotPinHash: pin ? await hashClassPilotPin(pin) : undefined,
          classpilotPinEncrypted: pin ? encryptClassPilotPin(pin) : undefined,
          status: "active",
        });
        if (pin) generatedPins.push(generatedPinForStudent(student, pin));
        imported++;
      }
    } catch (err) {
      skipped++;
      errors.push(`${email}: ${(err as Error).message}`);
    }
  }

  return { imported, updated, skipped, errors, generatedPins };
}

async function getAuthedClient(userId: string, schoolId: string) {
  const token = await getGoogleOAuthTokenForSchool(userId, schoolId);
  if (!token) throw routeError("NO_TOKENS: Google not connected for this school");
  const granted = new Set((token.scope || "").split(/\s+/).filter(Boolean));
  const missing = DIRECTORY_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw routeError(
      `MISSING_GOOGLE_SCOPE: Reconnect Google Workspace to grant Directory access (${missing.join(", ")}).`,
      400,
      "MISSING_GOOGLE_SCOPE"
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: token.refreshToken });
  return { oauth2Client, google };
}

// GET /api/google/workspace/orgunits - List org units
router.get("/orgunits", ...adminAuth, async (req, res, next) => {
  try {
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    const response = await admin.orgunits.list({
      customerId: "my_customer",
      orgUnitPath: "/",
      type: "allIncludingParent",
    });

    const rawOrgUnits = response.data.organizationUnits || [];
    // Auto-detect grade level from OU name (e.g. "Grade 7", "7th Grade", "8th")
    const orgUnits = rawOrgUnits
      .filter((ou: any) => ou.orgUnitPath && ou.orgUnitPath !== "/")
      .map((ou: any) => {
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

    return res.json({
      orgUnits,
      diagnostics: {
        rawOrgUnitsCount: rawOrgUnits.length,
        returnedRootOrgUnit: rawOrgUnits.some((ou: any) => ou.orgUnitPath === "/"),
      },
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// GET /api/google/workspace/users - List Workspace users
router.get("/users", ...adminAuth, async (req, res, next) => {
  try {
    const { orgUnitPath, pageToken } = req.query;
    const schoolId = res.locals.schoolId!;
    const pageTokenValue = optionalString(pageToken);
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    const response = await listDirectoryUsersForSchool(admin, schoolId, {
      orgUnitPath: optionalString(orgUnitPath),
      pageToken: pageTokenValue,
      paginateAll: !pageTokenValue,
    });

    if (response.users.length === 0 && !pageTokenValue) {
      console.warn(
        "[googleDirectory] users.list returned zero users",
        JSON.stringify({
          requestId: req.requestId,
          schoolId,
          orgUnitPath: optionalString(orgUnitPath) || null,
          source: response.source,
          customerUserCount: response.customerUserCount,
          domainFallbackAttempted: response.domainFallbackAttempted,
          domainUserCount: response.domainUserCount,
          queriedDomain: response.queriedDomain,
        })
      );
    }

    return res.json({
      users: response.users.map((u: any) => ({
        id: u.id,
        email: u.primaryEmail,
        firstName: u.name?.givenName || "",
        lastName: u.name?.familyName || "",
        orgUnitPath: u.orgUnitPath,
        suspended: u.suspended,
        isAdmin: Boolean(u.isAdmin || u.isDelegatedAdmin),
      })),
      nextPageToken: response.nextPageToken,
      source: response.source,
      diagnostics: {
        customerUserCount: response.customerUserCount,
        domainFallbackAttempted: response.domainFallbackAttempted,
        domainUserCount: response.domainUserCount,
        queriedDomain: response.queriedDomain,
      },
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// POST /api/google/workspace/import - Import selected users as students
// Accepts either:
//   { users: [...], grade } — direct user array (PassPilot)
//   { entries: [{orgUnitPath, gradeLevel, excludeEmails?}] } — OU-based import (ClassPilot)
//   { orgUnitPath, gradeLevel } — single OU import (PassPilot SetupView)
router.post("/import", ...adminAuth, async (req, res, next) => {
  try {
    const { users, grade, entries, orgUnitPath, gradeLevel, importAll } = req.body;
    const schoolId = res.locals.schoolId!;

    // OU-based import with entries array (ClassPilot Students page)
    if (Array.isArray(entries) && entries.length > 0) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

      let totalImported = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;
      let totalFound = 0;
      const details: unknown[] = [];
      const allErrors: string[] = [];
      const generatedPins: GeneratedClassPilotPin[] = [];
      const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);

      for (const entry of entries) {
        const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
          orgUnitPath: optionalString(entry.orgUnitPath),
          projection: "full",
        });
        totalFound += googleUsers.length;
        const result = await importGoogleUsersAsStudents(schoolId, googleUsers, {
          gradeLevel: entry.gradeLevel || entry.grade || null,
          excludeEmails: entry.excludeEmails,
          autoGenerateClassPilotPins,
        });

        totalImported += result.imported;
        totalUpdated += result.updated;
        totalSkipped += result.skipped;
        allErrors.push(...result.errors);
        generatedPins.push(...result.generatedPins);
        details.push({ orgUnitPath: entry.orgUnitPath || "all", ...result });
      }

      const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported);
      // Fire-and-forget: never block/delay the import response on logging.
      void recordImportRun({
        schoolId,
        userId: req.authUser?.id,
        requestId: req.requestId,
        source: "workspace_directory",
        scope: entries.map((e: any) => e.orgUnitPath || "all").join(", "),
        totalFound,
        imported: totalImported,
        updated: totalUpdated,
        skipped: totalSkipped,
        failures: allErrors,
      });
      return res.json({
        imported: totalImported,
        updated: totalUpdated,
        skipped: totalSkipped,
        errors: allErrors,
        details,
        autoAssigned,
        generatedPins,
      });
    }

    // Single OU or all-domain import (PassPilot/ClassPilot setup)
    if (orgUnitPath !== undefined || importAll === true) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });
      const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
        orgUnitPath: optionalString(orgUnitPath),
        projection: "full",
      });
      const result = await importGoogleUsersAsStudents(schoolId, googleUsers, {
        gradeLevel: gradeLevel || grade || null,
        autoGenerateClassPilotPins: await hasActiveClassPilotLicense(schoolId),
      });
      const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, result.imported);

      void recordImportRun({
        schoolId,
        userId: req.authUser?.id,
        requestId: req.requestId,
        source: "workspace_directory",
        scope: importAll === true ? "all" : (orgUnitPath || "all"),
        totalFound: googleUsers.length,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        failures: result.errors,
      });
      return res.json({ ...result, total: googleUsers.length, autoAssigned });
    }

    // Direct user array import (PassPilot)
    if (!Array.isArray(users) || users.length === 0) {
      return res
        .status(400)
        .json({ error: "users array, entries array, orgUnitPath, or importAll required" });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    const generatedPins: GeneratedClassPilotPin[] = [];
    const usedPins = new Set<string>();
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const rules = await studentEmailRules(schoolId);

    for (const u of users) {
      const email = u.email?.trim();
      if (!email) {
        skipped++;
        continue;
      }

      // Per-student try/catch — one bad row must not abort the batch.
      try {
        const emailLc = email.toLowerCase();
        const emailErr = checkStudentEmail(email, rules);
        if (emailErr) {
          skipped++;
          errors.push(`${email}: ${emailErr.error}`);
          continue;
        }
        const existing = await getStudentByEmail(schoolId, emailLc);
        const taken = await studentEmailTaken(schoolId, emailLc, existing?.id);
        if (taken) {
          skipped++;
          errors.push(`${email}: ${taken}`);
          continue;
        }
        if (existing) {
          await updateStudent(existing.id, {
            firstName: u.firstName || existing.firstName,
            lastName: u.lastName || existing.lastName,
            email,
            gradeLevel: grade || u.grade || existing.gradeLevel || undefined,
            googleUserId: u.id || existing.googleUserId || undefined,
          });
          updated++;
        } else {
          const pin = autoGenerateClassPilotPins ? randomFourDigitClassPilotPin(usedPins) : null;
          const student = await createStudent({
            schoolId,
            firstName: u.firstName || email.split("@")[0],
            lastName: u.lastName || "",
            email,
            gradeLevel: grade || u.grade || undefined,
            googleUserId: u.id || undefined,
            classpilotPinHash: pin ? await hashClassPilotPin(pin) : undefined,
            classpilotPinEncrypted: pin ? encryptClassPilotPin(pin) : undefined,
            status: "active",
          });
          if (pin) generatedPins.push(generatedPinForStudent(student, pin));
          imported++;
        }
      } catch (err) {
        skipped++;
        errors.push(`${email}: ${(err as Error).message}`);
      }
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, imported);
    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "workspace_direct",
      scope: null,
      totalFound: users.length,
      imported,
      updated,
      skipped,
      failures: errors,
    });
    return res.json({ imported, updated, skipped, errors, total: users.length, autoAssigned, generatedPins });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
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
    const errors: string[] = [];
    if (!["admin", "school_admin", "teacher", "office_staff"].includes(staffRole)) {
      return res.status(400).json({ error: "Invalid staff role", code: "INVALID_STAFF_ROLE" });
    }

    // If orgUnitPath provided, fetch users from Google Directory
    if (orgUnitPath || (orgUnitPath === undefined && !users)) {
      const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
      const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

      const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
        orgUnitPath: optionalString(orgUnitPath),
      });
      const filterIds = userIds ? new Set(userIds) : null;

      let imported = 0;
      let skipped = 0;

      for (const u of googleUsers) {
        if (u.suspended) continue;
        const email = u.primaryEmail?.trim();
        if (!email) continue;
        if (filterIds && !filterIds.has(u.id)) continue;
        const validation = await validateStaffImportEmailForSchool(email, schoolId);
        if (validation) {
          skipped++;
          errors.push(formatImportPolicyError(email, validation));
          continue;
        }

        let user = await getUserByEmail(email);
        let createdUser = false;
        if (!user) {
          user = await createUser({
            email,
            firstName: u.name?.givenName || email.split("@")[0],
            lastName: u.name?.familyName || "",
            googleId: u.id || null,
          });
          createdUser = true;
        }

        const existing = await getMembershipByUserAndSchool(user.id, schoolId);
        if (!existing) {
          try {
            await createMembership({
              userId: user.id,
              schoolId,
              role: staffRole,
              status: "active",
            });
          } catch (err: any) {
            skipped++;
            errors.push(`${email}: ${err?.code || "MEMBERSHIP_CREATE_FAILED"}: ${err?.message || "Could not create staff membership."}`);
            continue;
          }
        }

        if (createdUser) {
          imported++;
        } else {
          skipped++;
        }
      }

      void recordImportRun({
        schoolId,
        userId: req.authUser?.id,
        requestId: req.requestId,
        source: "workspace_staff",
        scope: orgUnitPath || "all",
        totalFound: googleUsers.length,
        imported,
        updated: 0,
        skipped,
        failures: errors,
      });
      return res.json({ imported, skipped, updated: skipped, errors, total: imported + skipped });
    }

    // Direct user array import
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array or orgUnitPath required" });
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const u of users) {
      const email = String(u.email || "").trim();
      if (!email) {
        skipped++;
        errors.push("missing email: Staff email is required.");
        continue;
      }
      const validation = await validateStaffImportEmailForSchool(email, schoolId);
      if (validation) {
        skipped++;
        errors.push(formatImportPolicyError(email, validation));
        continue;
      }
      let user = await getUserByEmail(email);
      let createdUser = false;
      if (!user) {
        user = await createUser({
          email,
          firstName: u.firstName || email.split("@")[0],
          lastName: u.lastName || "",
          googleId: u.id || null,
        });
        createdUser = true;
      } else {
        updated++;
      }

      const existing = await getMembershipByUserAndSchool(user.id, schoolId);
      if (!existing) {
        try {
          await createMembership({
            userId: user.id,
            schoolId,
            role: staffRole,
            status: "active",
          });
        } catch (err: any) {
          skipped++;
          if (!createdUser) updated--;
          errors.push(`${email}: ${err?.code || "MEMBERSHIP_CREATE_FAILED"}: ${err?.message || "Could not create staff membership."}`);
          continue;
        }
      }
      if (createdUser) imported++;
    }

    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "workspace_staff",
      scope: null,
      totalFound: users.length,
      imported,
      updated,
      skipped,
      failures: errors,
    });
    return res.json({ imported, updated, skipped, errors, total: users.length });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
};

// POST /api/google/workspace/import-orgunits - Bulk import users from multiple org units
router.post("/import-orgunits", ...adminAuth, async (req, res, next) => {
  try {
    const { orgUnits, grade } = req.body;
    if (!Array.isArray(orgUnits) || orgUnits.length === 0) {
      return res.status(400).json({ error: "orgUnits array required" });
    }

    const schoolId = res.locals.schoolId!;
    const { oauth2Client, google } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
    const admin = google.admin({ version: "directory_v1", auth: oauth2Client });

    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFound = 0;
    const details: unknown[] = [];
    const allErrors: string[] = [];
    const generatedPins: GeneratedClassPilotPin[] = [];
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);

    for (const entry of orgUnits) {
      const orgUnitPath = typeof entry === "string" ? entry : entry?.orgUnitPath;
      const gradeLevel = typeof entry === "string" ? grade : entry?.gradeLevel || entry?.grade || grade;
      const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
        orgUnitPath: optionalString(orgUnitPath),
        projection: "full",
      });
      totalFound += googleUsers.length;
      const result = await importGoogleUsersAsStudents(schoolId, googleUsers, {
        gradeLevel,
        excludeEmails: typeof entry === "string" ? undefined : entry?.excludeEmails,
        autoGenerateClassPilotPins,
      });

      totalImported += result.imported;
      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      allErrors.push(...result.errors);
      generatedPins.push(...result.generatedPins);
      details.push({ orgUnitPath: orgUnitPath || "all", ...result });
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported);
    void recordImportRun({
      schoolId,
      userId: req.authUser?.id,
      requestId: req.requestId,
      source: "workspace_directory",
      scope: orgUnits.map((e: any) => (typeof e === "string" ? e : e?.orgUnitPath || "all")).join(", "),
      totalFound,
      imported: totalImported,
      updated: totalUpdated,
      skipped: totalSkipped,
      failures: allErrors,
    });
    return res.json({
      imported: totalImported,
      updated: totalUpdated,
      skipped: totalSkipped,
      details,
      autoAssigned,
      generatedPins,
    });
  } catch (err: any) {
    return handleGoogleError(err, res, next);
  }
});

// POST /api/google/workspace/import-staff - Import users as staff
router.post("/import-staff", ...adminAuth, importStaffHandler);

// POST /import-teachers - Alias for import-staff (PassPilot compatibility)
router.post("/import-teachers", ...adminAuth, importStaffHandler);

export default router;
