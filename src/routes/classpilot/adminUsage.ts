import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { readClasspilotDigitalUsageMode } from "../../config/classpilotUsageModes.js";
import { logAuditStrict } from "../../services/audit.js";
import {
  ClasspilotDigitalUsageError,
  classpilotDigitalUsageCsv,
  classpilotDigitalUsageCsvFileName,
  getClasspilotDigitalUsage,
  parseClasspilotDigitalUsageQuery,
} from "../../services/classpilotUsageRead.js";

/**
 * GET /api/classpilot/admin/usage?scope=school|grade|class|student&id&from&to&format=json|csv
 *
 * Digital Usage ("Monitored Browser Time") for administrators. With
 * CLASSPILOT_DIGITAL_USAGE_MODE off, or either usage table not
 * RLS-admitted, this router steps aside before authentication and every
 * request receives the same JSON 404 as any unknown API path.
 */
const router = Router();

router.use((_req, _res, next) => {
  if (readClasspilotDigitalUsageMode() !== "on") return next("router");
  return next();
});

// monitoring.ts adminAuth: the ClassPilot entitlement gate included.
const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

router.get("/", ...adminAuth, async (req, res, next) => {
  try {
    const query = parseClasspilotDigitalUsageQuery(req.query as Record<string, unknown>);
    const schoolId = res.locals.schoolId!;
    const report = await getClasspilotDigitalUsage({
      schoolId,
      scope: query.scope,
      id: query.id,
      from: query.from,
      to: query.to,
    });
    if (query.format === "csv") {
      // An export is never sent unaudited.
      await logAuditStrict({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
        action: "classpilot.usage.export",
        entityType: `classpilot_usage_${query.scope}`,
        entityId: query.id ?? schoolId,
        metadata: {
          scope: query.scope,
          from: report.range.from,
          to: report.range.to,
          presentedDays: report.byDay.length,
          dataState: report.dataState,
        },
      });
      res.set({
        "Cache-Control": "no-store, private",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${classpilotDigitalUsageCsvFileName(report)}"`,
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(classpilotDigitalUsageCsv(report));
    }
    res.set("Cache-Control", "no-store, private");
    return res.json(report);
  } catch (error) {
    if (error instanceof ClasspilotDigitalUsageError) {
      res.set("Cache-Control", "no-store, private");
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    next(error);
  }
});

export default router;
