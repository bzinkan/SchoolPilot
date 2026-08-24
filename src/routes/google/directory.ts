import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getRequestGoPilotRole,
  hasActiveGoPilotLicense,
} from "../../services/gopilotAccess.js";
import {
  isDisabledGoPilotParentRole,
  sendGoPilotParentPortalDisabled,
} from "../../util/gopilotParentContainment.js";
import {
  createStudent,
  reactivateInactiveStudentForRosterImport,
  getStudentByEmail,
  getMembershipsByUserAndSchoolIncludingInactive,
  isStaffMembershipRole,
  updateMembershipForSchool,
  getProductLicenses,
  getSchoolById,
  normalizeDomain,
  autoAssignFamilyGroups,
  markGoogleRosterConnectorSynced,
} from "../../services/storage.js";
import {
  attachWorkspaceStaffMembershipForSchool,
  isStaffIdentityError,
  resolveWorkspaceStaffUserForSchool,
} from "../../services/staffIdentity.js";
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
import { getRosterDirectoryClientForSchool } from "../../services/googleRosterConnector.js";
import errorMonitor from "../../services/errorMonitor.js";
import { safeErrorMetadata } from "../../util/safeLogging.js";

const router = Router();

export function selectWorkspaceStaffMembershipState<
  T extends { status: string; role: string; gopilotRole: string | null },
>(memberships: T[]): { existing?: T; inactive?: T } {
  const staffMemberships = memberships.filter(isStaffMembershipRole);
  return {
    existing: staffMemberships.find((membership) => membership.status === "active"),
    inactive: staffMemberships.find((membership) => membership.status !== "active"),
  };
}

/** Client-authored direct import rows never provide immutable identity proof. */
export function workspaceStaffGoogleId(
  user: { id?: unknown },
  serverFetchedDirectoryRow: boolean
): string | null {
  if (!serverFetchedDirectoryRow || typeof user.id !== "string") return null;
  return user.id.trim() || null;
}

export function canAttachGlobalWorkspaceIdentity(
  isSuperAdmin: boolean,
  explicitlyConfirmed: boolean
): boolean {
  return isSuperAdmin && explicitlyConfirmed;
}

const requireBaseDirectoryAdmin = requireRole("admin", "school_admin");
const requireDirectoryAdmin: import("express").RequestHandler = async (req, res, next) => {
  const goPilotSetup = res.locals.goPilotSetup === true;
  if (!goPilotSetup) {
    if (!(await hasActiveClassPilotLicense(res.locals.schoolId!))) {
      const role = await getRequestGoPilotRole(req, res);
      if (isDisabledGoPilotParentRole(role) && await hasActiveGoPilotLicense(res.locals.schoolId!)) {
        return sendGoPilotParentPortalDisabled(res);
      }
      return res.status(403).json({ error: "Product license required" });
    }
    return requireBaseDirectoryAdmin(req, res, next);
  }
  const role = await getRequestGoPilotRole(req, res);
  if (isDisabledGoPilotParentRole(role)) return sendGoPilotParentPortalDisabled(res);
  if (!(await hasActiveGoPilotLicense(res.locals.schoolId!))) {
    return res.status(403).json({ error: "Product license required" });
  }
  if (role !== "super_admin" && role !== "admin" && role !== "school_admin") {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  return next();
};

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireDirectoryAdmin,
] as const;

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
  if (err.message?.includes("GOOGLE_CONNECTOR_REQUIRED")) {
    return res.status(400).json({
      error: err.message,
      code: "GOOGLE_CONNECTOR_REQUIRED",
    });
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

export function formatStaffIdentityImportError(email: string, error: unknown): string {
  if (isStaffIdentityError(error)) {
    return `${email}: ${error.code}: ${error.message}`;
  }
  return `${email}: STAFF_IDENTITY_FAILED: Could not resolve staff identity.`;
}

type StaffMembershipImportOperation = "create" | "update";

export function formatStaffMembershipImportError(
  email: string,
  operation: StaffMembershipImportOperation
): string {
  const code = operation === "create" ? "MEMBERSHIP_CREATE_FAILED" : "MEMBERSHIP_UPDATE_FAILED";
  const message = operation === "create"
    ? "Could not create staff membership."
    : "Could not update staff membership.";
  return `${email}: ${code}: ${message}`;
}

function reportUnexpectedStaffImportError(
  operation: "identity" | StaffMembershipImportOperation,
  error: unknown
): void {
  const metadata = safeErrorMetadata(error);
  console.error(`[GoogleDirectory] Workspace staff ${operation} failed:`, metadata);
  errorMonitor.trackError(
    "api_error",
    new Error("Workspace staff import operation failed"),
    {
      job: "workspaceStaffImport",
      errorCode: operation === "identity"
        ? "STAFF_IDENTITY_FAILED"
        : operation === "create"
          ? "MEMBERSHIP_CREATE_FAILED"
          : "MEMBERSHIP_UPDATE_FAILED",
    }
  );
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
  const now = Date.now();
  return licenses.some(
    (license) => license.product === "CLASSPILOT"
      && license.status === "active"
      && (!license.expiresAt || new Date(license.expiresAt).getTime() > now)
  );
}

async function importGoogleUsersAsStudents(
  schoolId: string,
  googleUsers: any[],
  options: {
    gradeLevel?: string | null;
    excludeEmails?: string[];
    autoGenerateClassPilotPins?: boolean;
    actor: {
      userId: string | null;
      userEmail?: string;
      userRole?: string;
      source: string;
    };
  }
) {
  const excludeSet = new Set(
    (options.excludeEmails || []).map((email) => String(email).toLowerCase())
  );
  let imported = 0;
  let updated = 0;
  let restored = 0;
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
        const result = await reactivateInactiveStudentForRosterImport(schoolId, emailLc, {
          firstName: u.name?.givenName || existing.firstName,
          lastName: u.name?.familyName || existing.lastName,
          email,
          gradeLevel: options.gradeLevel || existing.gradeLevel || undefined,
          googleUserId: u.id || existing.googleUserId || undefined,
          studentIdNumber: studentIdNumber || existing.studentIdNumber || undefined,
        }, options.actor);
        updated++;
        if (result.reactivated) restored++;
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

  return { imported, updated, restored, skipped, errors, generatedPins };
}

async function getAuthedClient(userId: string, schoolId: string) {
  void userId;
  return getRosterDirectoryClientForSchool(schoolId);
}

// GET /api/google/workspace/orgunits - List org units
router.get("/orgunits", ...adminAuth, async (req, res, next) => {
  try {
    const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);

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
    const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);

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
          source: response.source,
          customerUserCount: response.customerUserCount,
          domainFallbackAttempted: response.domainFallbackAttempted,
          domainUserCount: response.domainUserCount,
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
    const lifecycleActor = {
      userId: req.authUser?.id ?? null,
      userEmail: req.authUser?.email ?? undefined,
      userRole: res.locals.membershipRole,
      source: "google_workspace_import",
    };

    // OU-based import with entries array (ClassPilot Students page)
    if (Array.isArray(entries) && entries.length > 0) {
      const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);

      let totalImported = 0;
      let totalUpdated = 0;
      let totalRestored = 0;
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
          actor: lifecycleActor,
        });

        totalImported += result.imported;
        totalUpdated += result.updated;
        totalRestored += result.restored;
        totalSkipped += result.skipped;
        allErrors.push(...result.errors);
        generatedPins.push(...result.generatedPins);
        details.push({ orgUnitPath: entry.orgUnitPath || "all", ...result });
      }

      const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported + totalRestored);
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
      await markGoogleRosterConnectorSynced(schoolId);
      return res.json({
        imported: totalImported,
        updated: totalUpdated,
        restored: totalRestored,
        skipped: totalSkipped,
        errors: allErrors,
        details,
        autoAssigned,
        generatedPins,
      });
    }

    // Single OU or all-domain import (PassPilot/ClassPilot setup)
    if (orgUnitPath !== undefined || importAll === true) {
      const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);
      const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
        orgUnitPath: optionalString(orgUnitPath),
        projection: "full",
      });
      const result = await importGoogleUsersAsStudents(schoolId, googleUsers, {
        gradeLevel: gradeLevel || grade || null,
        autoGenerateClassPilotPins: await hasActiveClassPilotLicense(schoolId),
        actor: lifecycleActor,
      });
      const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, result.imported + result.restored);

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
      await markGoogleRosterConnectorSynced(schoolId);
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
    let restored = 0;
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
          const result = await reactivateInactiveStudentForRosterImport(schoolId, emailLc, {
            firstName: u.firstName || existing.firstName,
            lastName: u.lastName || existing.lastName,
            email,
            gradeLevel: grade || u.grade || existing.gradeLevel || undefined,
            googleUserId: u.id || existing.googleUserId || undefined,
          }, lifecycleActor);
          updated++;
          if (result.reactivated) restored++;
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

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, imported + restored);
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
    return res.json({ imported, updated, restored, skipped, errors, total: users.length, autoAssigned, generatedPins });
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
    const fromGoPilotSetup = res.locals.goPilotSetup === true;
    const membershipRole = fromGoPilotSetup && staffRole === "office_staff" ? "teacher" : staffRole;
    const gopilotRole = fromGoPilotSetup && staffRole === "office_staff" ? "office_staff" : null;
    const shouldNormalizeExistingOffice = fromGoPilotSetup && staffRole === "office_staff";
    const allowGlobalIdentityAttachment = canAttachGlobalWorkspaceIdentity(
      req.authUser?.isSuperAdmin === true,
      req.body?.confirmGlobalIdentityAttachment === true
    );
    const canNormalizeExistingOfficeMembership = (existing: any) =>
      shouldNormalizeExistingOffice &&
      existing?.status === "active" &&
      !["admin", "school_admin"].includes(existing.role) &&
      (existing.role === "teacher" || existing.role === "office_staff" || existing.gopilotRole === "office_staff");
    const errors: string[] = [];
    if (!["admin", "school_admin", "teacher", "office_staff"].includes(staffRole)) {
      return res.status(400).json({ error: "Invalid staff role", code: "INVALID_STAFF_ROLE" });
    }

    // If orgUnitPath provided, fetch users from Google Directory
    if (orgUnitPath || (orgUnitPath === undefined && !users)) {
      const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);

      const { users: googleUsers } = await listDirectoryUsersForSchool(admin, schoolId, {
        orgUnitPath: optionalString(orgUnitPath),
      });
      const filterIds = userIds ? new Set(userIds) : null;

      let imported = 0;
      let updated = 0;
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

        let identity;
        try {
          identity = await resolveWorkspaceStaffUserForSchool({
            schoolId,
            email,
            googleId: workspaceStaffGoogleId(u, true),
            firstName: u.name?.givenName || email.split("@")[0],
            lastName: u.name?.familyName || "",
            allowMultiSchoolEmailChange: req.authUser?.isSuperAdmin === true,
            allowGlobalIdentityAttachment,
            audit: {
              userId: req.authUser!.id,
              userRole: res.locals.gopilotRole ?? res.locals.membershipRole,
              source: "google.directory.staff.import",
            },
          });
        } catch (error) {
          skipped++;
          if (!isStaffIdentityError(error)) {
            reportUnexpectedStaffImportError("identity", error);
          }
          errors.push(formatStaffIdentityImportError(email, error));
          continue;
        }
        const { user, createdUser } = identity;
        const existingMemberships = await getMembershipsByUserAndSchoolIncludingInactive(
          user.id,
          schoolId
        );
        const { existing, inactive } =
          selectWorkspaceStaffMembershipState(existingMemberships);
        if (!existing && inactive) {
          skipped++;
          errors.push(`${email}: STAFF_REACTIVATION_REQUIRED: Reactivate membership ${inactive.id} instead of creating a new identity.`);
          continue;
        }
        if (existing && canNormalizeExistingOfficeMembership(existing)) {
          try {
            await updateMembershipForSchool(existing.id, schoolId, {
              role: membershipRole,
              gopilotRole,
            }, undefined, allowGlobalIdentityAttachment);
            updated++;
          } catch (err) {
            skipped++;
            reportUnexpectedStaffImportError("update", err);
            errors.push(formatStaffMembershipImportError(email, "update"));
            continue;
          }
        } else if (existing) {
          if (identity.emailChanged) updated++;
          else skipped++;
        } else {
          try {
            await attachWorkspaceStaffMembershipForSchool({
              userId: user.id,
              schoolId,
              role: membershipRole,
              gopilotRole,
              allowGlobalIdentityAttachment,
              audit: {
                userId: req.authUser!.id,
                userRole: res.locals.gopilotRole ?? res.locals.membershipRole,
                source: "google.directory.staff.import",
              },
            });
          } catch (err) {
            skipped++;
            if (isStaffIdentityError(err)) {
              errors.push(formatStaffIdentityImportError(email, err));
            } else {
              reportUnexpectedStaffImportError("create", err);
              errors.push(formatStaffMembershipImportError(email, "create"));
            }
            continue;
          }
        }

        if (createdUser) {
          imported++;
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
        updated,
        skipped,
        failures: errors,
      });
      await markGoogleRosterConnectorSynced(schoolId);
      return res.json({ imported, skipped, updated, errors, total: googleUsers.length });
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
      let identity;
      try {
        identity = await resolveWorkspaceStaffUserForSchool({
          schoolId,
          email,
          // Direct users[] payloads are client-authored. Their Google IDs are
          // not identity evidence; only the server-fetched OU path may bind an
          // immutable Directory ID.
          googleId: workspaceStaffGoogleId(u, false),
          firstName: u.firstName || email.split("@")[0],
          lastName: u.lastName || "",
          allowMultiSchoolEmailChange: req.authUser?.isSuperAdmin === true,
          allowGlobalIdentityAttachment,
          audit: {
            userId: req.authUser!.id,
            userRole: res.locals.gopilotRole ?? res.locals.membershipRole,
            source: "google.directory.staff.direct_import",
          },
        });
      } catch (error) {
        skipped++;
        if (!isStaffIdentityError(error)) {
          reportUnexpectedStaffImportError("identity", error);
        }
        errors.push(formatStaffIdentityImportError(email, error));
        continue;
      }
      const { user, createdUser } = identity;
      if (!createdUser) updated++;

      const existingMemberships = await getMembershipsByUserAndSchoolIncludingInactive(
        user.id,
        schoolId
      );
      const { existing, inactive } =
        selectWorkspaceStaffMembershipState(existingMemberships);
      if (!existing && inactive) {
        skipped++;
        if (!createdUser) updated--;
        errors.push(`${email}: STAFF_REACTIVATION_REQUIRED: Reactivate membership ${inactive.id} instead of creating a new identity.`);
        continue;
      }
      if (existing && canNormalizeExistingOfficeMembership(existing)) {
        try {
          await updateMembershipForSchool(existing.id, schoolId, {
            role: membershipRole,
            gopilotRole,
          }, undefined, allowGlobalIdentityAttachment);
        } catch (err) {
          skipped++;
          if (!createdUser) updated--;
          reportUnexpectedStaffImportError("update", err);
          errors.push(formatStaffMembershipImportError(email, "update"));
          continue;
        }
      } else if (existing && shouldNormalizeExistingOffice) {
        skipped++;
        if (!createdUser) updated--;
        continue;
      } else if (existing) {
        // Existing non-GoPilot-setup staff import preserves the current membership role.
      } else {
        try {
          await attachWorkspaceStaffMembershipForSchool({
            userId: user.id,
            schoolId,
            role: membershipRole,
            gopilotRole,
            allowGlobalIdentityAttachment,
            audit: {
              userId: req.authUser!.id,
              userRole: res.locals.gopilotRole ?? res.locals.membershipRole,
              source: "google.directory.staff.direct_import",
            },
          });
        } catch (err) {
          skipped++;
          if (!createdUser) updated--;
          if (isStaffIdentityError(err)) {
            errors.push(formatStaffIdentityImportError(email, err));
          } else {
            reportUnexpectedStaffImportError("create", err);
            errors.push(formatStaffMembershipImportError(email, "create"));
          }
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
    const { admin } = await getAuthedClient(req.authUser!.id, res.locals.schoolId!);

    let totalImported = 0;
    let totalUpdated = 0;
    let totalRestored = 0;
    let totalSkipped = 0;
    let totalFound = 0;
    const details: unknown[] = [];
    const allErrors: string[] = [];
    const generatedPins: GeneratedClassPilotPin[] = [];
    const autoGenerateClassPilotPins = await hasActiveClassPilotLicense(schoolId);
    const lifecycleActor = {
      userId: req.authUser?.id ?? null,
      userEmail: req.authUser?.email ?? undefined,
      userRole: res.locals.membershipRole,
      source: "google_workspace_orgunit_import",
    };

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
        actor: lifecycleActor,
      });

      totalImported += result.imported;
      totalUpdated += result.updated;
      totalRestored += result.restored;
      totalSkipped += result.skipped;
      allErrors.push(...result.errors);
      generatedPins.push(...result.generatedPins);
      details.push({ orgUnitPath: orgUnitPath || "all", ...result });
    }

    const autoAssigned = await maybeAutoAssignGoPilotFamilies(schoolId, totalImported + totalRestored);
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
    await markGoogleRosterConnectorSynced(schoolId);
    return res.json({
      imported: totalImported,
      updated: totalUpdated,
      restored: totalRestored,
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
