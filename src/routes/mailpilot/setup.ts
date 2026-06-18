import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getSchoolById,
  getMailpilotWatchesBySchool,
} from "../../services/storage.js";
import {
  getServiceAccountClientId,
  getServiceAccountScope,
  isMailpilotConfigured,
} from "../../services/mailpilotGmail.js";
import { logAudit } from "../../services/audit.js";
import {
  MailpilotProvisioningError,
  resyncMailpilotMonitoringForSchool,
  startMailpilotMonitoringForSchool,
  stopMailpilotMonitoringForSchool,
  verifyMailpilotMailboxForSchool,
} from "../../services/mailpilotProvisioning.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

function handleMailpilotError(err: unknown, res: any, next: any) {
  if (err instanceof MailpilotProvisioningError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
    });
  }
  return next(err);
}

async function requireMailPilotEntitlement(_req: any, res: any, next: any) {
  try {
    const school = await getSchoolById(res.locals.schoolId!);
    if (!school?.mailpilotEntitled) {
      return res.status(403).json({ error: "MailPilot is not enabled for this school" });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/mailpilot/setup/info - wizard info (SA client ID, scope, enabled flag)
router.get("/setup/info", ...auth, requireMailPilotEntitlement, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const school = await getSchoolById(schoolId);
    const clientId = getServiceAccountClientId();
    const configured = isMailpilotConfigured();
    const orgUnits = school?.mailpilotOrgUnits ? safeParseJson(school.mailpilotOrgUnits) : [];
    const watches = await getMailpilotWatchesBySchool(schoolId);

    return res.json({
      entitled: Boolean(school?.mailpilotEntitled),
      enabled: Boolean(school?.classpilotEmailMonitoring),
      configured, // server has SA key + Pub/Sub topic configured
      serviceAccountClientId: clientId,
      scope: getServiceAccountScope(),
      orgUnits,
      mailboxesMonitored: watches.filter((w) => w.status === "active").length,
      mailboxesWithErrors: watches.filter((w) => w.status === "error").length,
      totalWatches: watches.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailpilot/setup/verify - test DWD by calling Gmail API for one student
router.post("/setup/verify", ...auth, requireMailPilotEntitlement, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { testEmail } = req.body as { testEmail?: string };
    return res.json(await verifyMailpilotMailboxForSchool(schoolId, testEmail));
  } catch (err) {
    return handleMailpilotError(err, res, next);
  }
});

// POST /api/mailpilot/setup/enable - turn monitoring ON + start watches
router.post("/setup/enable", ...auth, requireMailPilotEntitlement, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { orgUnitPaths, studentIds } = req.body as {
      orgUnitPaths?: string[];
      studentIds?: string[];
    };
    const result = await startMailpilotMonitoringForSchool(schoolId, { orgUnitPaths, studentIds });

    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "mailpilot_enable",
      entityType: "school",
      entityId: schoolId,
      schoolId,
      metadata: {
        studentsTargeted: result.studentsTargeted,
        started: result.watchesStarted,
        failed: result.failed,
      },
    });

    return res.json(result);
  } catch (err) {
    return handleMailpilotError(err, res, next);
  }
});

// POST /api/mailpilot/setup/disable - turn monitoring OFF + stop all watches
router.post("/setup/disable", ...auth, requireMailPilotEntitlement, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const result = await stopMailpilotMonitoringForSchool(schoolId);

    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "mailpilot_disable",
      entityType: "school",
      entityId: schoolId,
      schoolId,
      metadata: { watchesStopped: result.watchesStopped },
    });

    return res.json(result);
  } catch (err) {
    return handleMailpilotError(err, res, next);
  }
});

// POST /api/mailpilot/setup/resync - re-enumerate students and sync watches (add new, stop removed)
router.post("/setup/resync", ...auth, requireMailPilotEntitlement, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const result = await resyncMailpilotMonitoringForSchool(schoolId);
    return res.json(result);
  } catch (err) {
    return handleMailpilotError(err, res, next);
  }
});

function safeParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
