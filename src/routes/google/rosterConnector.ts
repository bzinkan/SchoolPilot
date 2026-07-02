import { Router } from "express";
import { google } from "googleapis";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { logAudit } from "../../services/audit.js";
import {
  getGoogleRosterConnector,
  getSchoolById,
  getEmailDomain,
  normalizeDomain,
  updateGoogleRosterConnector,
  upsertGoogleRosterConnector,
} from "../../services/storage.js";
import {
  GOOGLE_ROSTER_SCOPES,
  getRosterDwdAuthClient,
  getRosterServiceAccountInfo,
} from "../../services/googleRosterConnector.js";
import { isTransientGoogleError } from "../../util/transientGoogleError.js";

const router = Router();

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireRole("admin", "school_admin"),
] as const;

const ADMIN_CONSOLE_DWD_URL = "https://admin.google.com/ac/owl/domainwidedelegation";
const MANUAL_ADMIN_CONSOLE_PATH =
  "Security \u2192 Access and data control \u2192 API controls \u2192 Domain-wide delegation \u2192 Manage Domain Wide Delegation";

function routeError(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function safeConnector(connector: Awaited<ReturnType<typeof getGoogleRosterConnector>>) {
  if (!connector) return null;
  return {
    connected: connector.status === "verified",
    status: connector.status,
    domain: connector.domain,
    delegatedAdminEmail: connector.delegatedAdminEmail,
    serviceAccountClientId: connector.serviceAccountClientId,
    approvedScopes: connector.approvedScopes,
    authMode: connector.authMode,
    verifiedAt: connector.verifiedAt,
    lastSyncAt: connector.lastSyncAt,
    disabledAt: connector.disabledAt,
    lastError: connector.lastError,
  };
}

async function setupPayload(schoolId: string) {
  const school = await getSchoolById(schoolId);
  const serviceAccount = getRosterServiceAccountInfo();
  const connector = await getGoogleRosterConnector(schoolId);
  const safe = safeConnector(connector);
  const scopes = [...GOOGLE_ROSTER_SCOPES];
  return {
    serviceAccount,
    serviceAccountClientId: serviceAccount.clientId,
    scopes,
    scopesCsv: scopes.join(","),
    adminConsoleUrl: ADMIN_CONSOLE_DWD_URL,
    manualAdminConsolePath: MANUAL_ADMIN_CONSOLE_PATH,
    schoolDomain: normalizeDomain(school?.domain),
    status: safe?.status || "not_connected",
    verifiedAt: safe?.verifiedAt || null,
    lastSyncAt: safe?.lastSyncAt || null,
    connector: safe,
    setupCopy: {
      title: "Google Workspace Roster Connector",
      adminConsoleUrl: ADMIN_CONSOLE_DWD_URL,
      adminConsolePath: MANUAL_ADMIN_CONSOLE_PATH,
      manualAdminConsolePath: MANUAL_ADMIN_CONSOLE_PATH,
      googleAdminInstruction:
        "Click Add new, paste the Client ID, paste the copied OAuth scopes, then click Authorize.",
      description:
        "Authorize SchoolPilot's read-only roster connector with these exact scopes. This does not grant Gmail, Drive, Calendar, or write access.",
      revocation:
        "Disconnecting in SchoolPilot disables imports locally. To fully revoke Google access, delete this client from Google Admin Console domain-wide delegation.",
    },
  };
}

router.get("/setup-info", ...adminAuth, async (_req, res, next) => {
  try {
    return res.json(await setupPayload(res.locals.schoolId!));
  } catch (err) {
    next(err);
  }
});

router.get("/status", ...adminAuth, async (_req, res, next) => {
  try {
    const connector = await getGoogleRosterConnector(res.locals.schoolId!);
    return res.json({ connector: safeConnector(connector) });
  } catch (err) {
    next(err);
  }
});

router.post("/verify", ...adminAuth, async (req, res, next) => {
  const schoolId = res.locals.schoolId!;
  try {
    const delegatedAdminEmail = String(req.body?.delegatedAdminEmail || "").trim().toLowerCase();
    if (!delegatedAdminEmail || !delegatedAdminEmail.includes("@")) {
      throw routeError("A delegated Google Workspace admin email is required.", 400, "DELEGATED_ADMIN_EMAIL_REQUIRED");
    }

    const school = await getSchoolById(schoolId);
    const schoolDomain = normalizeDomain(school?.domain);
    if (!schoolDomain) {
      throw routeError("School domain is required before connecting Google Workspace.", 400, "SCHOOL_DOMAIN_REQUIRED");
    }
    const delegatedDomain = normalizeDomain(getEmailDomain(delegatedAdminEmail));
    if (delegatedDomain !== schoolDomain) {
      throw routeError(
        `Delegated admin email must use the school's Google Workspace domain (${schoolDomain}).`,
        400,
        "GOOGLE_DOMAIN_MISMATCH"
      );
    }

    const serviceAccount = getRosterServiceAccountInfo();
    if (!serviceAccount.configured || !serviceAccount.clientId) {
      throw routeError(
        "Google Workspace Roster Connector is not configured on the SchoolPilot server.",
        503,
        "GOOGLE_ROSTER_CONNECTOR_NOT_CONFIGURED"
      );
    }

    const auth = await getRosterDwdAuthClient(delegatedAdminEmail, GOOGLE_ROSTER_SCOPES);
    const admin = google.admin({ version: "directory_v1", auth });
    const classroom = google.classroom({ version: "v1", auth });

    await admin.orgunits.list({
      customerId: "my_customer",
      orgUnitPath: "/",
      type: "children",
    });
    await classroom.courses.list({
      courseStates: ["ACTIVE"],
      pageSize: 1,
    });

    const connector = await upsertGoogleRosterConnector(schoolId, {
      domain: schoolDomain,
      delegatedAdminEmail,
      serviceAccountClientId: serviceAccount.clientId,
      approvedScopes: [...GOOGLE_ROSTER_SCOPES],
      authMode: serviceAccount.authMode,
      status: "verified",
      verifiedAt: new Date(),
      disabledAt: null,
      lastError: null,
      connectedByUserId: req.authUser!.id,
    });

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "google.roster_connector.verified",
      entityType: "google_roster_connector",
      entityId: connector.id,
      metadata: {
        delegatedAdminEmail,
        serviceAccountClientId: serviceAccount.clientId,
        scopes: GOOGLE_ROSTER_SCOPES,
      },
    });

    return res.json({ connector: safeConnector(connector) });
  } catch (err: any) {
    await updateGoogleRosterConnector(schoolId, {
      ...(isTransientGoogleError(err) ? {} : { status: "error" as const }),
      lastError: err?.message || "Google roster connector verification failed.",
    }).catch(() => {});
    next(err);
  }
});

router.delete("/", ...adminAuth, async (req, res, next) => {
  try {
    const connector = await updateGoogleRosterConnector(res.locals.schoolId!, {
      status: "disabled",
      disabledAt: new Date(),
      lastError: null,
    });
    if (connector) {
      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
        action: "google.roster_connector.disabled",
        entityType: "google_roster_connector",
        entityId: connector.id,
      });
    }
    return res.json({
      success: true,
      connector: safeConnector(connector),
      revocation:
        "SchoolPilot disabled roster imports locally. To fully revoke Google access, delete the service account client from Google Admin Console domain-wide delegation.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
