import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContextWithoutTenantBinding } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { clearSessionCookie } from "../../config/sessionCookie.js";
import { readClasspilotDigitalUsageMode } from "../../config/classpilotUsageModes.js";
import { logAuditStrict } from "../../services/audit.js";
import { authorizeClasspilotUsage } from "../../services/classpilotUsageAuthorization.js";
import { runClasspilotUsageExecution } from "../../services/classpilotUsageExecution.js";
import {
  classpilotUsageAdmission, ClasspilotUsageBusyError,
} from "../../services/classpilotUsageAdmission.js";
import { runWithUsageCapacityOperation } from "../../services/usageCapacityDiagnostics.js";
import {
  beginClasspilotUsageRequest, classpilotUsageRequest, guardClasspilotUsageMiddleware,
} from "../../services/classpilotUsageRequest.js";
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

// Admission comes before a tenant lease. Entitlement and fresh membership are
// checked again on that one lease after waiting, before reading any report.
const adminAuth = [
  authenticate,
  requireSchoolContextWithoutTenantBinding,
  requireRole("admin", "school_admin"),
] as const;

router.get("/", beginClasspilotUsageRequest(), ...adminAuth.map(guardClasspilotUsageMiddleware), async (req, res, next) => {
  const { controller, deadlineAt, sessionSchoolVersion, sessionSchoolId, sendBusy, check } = classpilotUsageRequest(res);
  let release: (() => void) | undefined;
  try {
    if (res.destroyed || res.closed) return;
    check();
    const query = parseClasspilotDigitalUsageQuery(req.query as Record<string, unknown>);
    const schoolId = res.locals.schoolId;
    if (typeof schoolId !== "string" || !schoolId) {
      throw new ClasspilotDigitalUsageError("CLASSPILOT_SCHOOL_CONTEXT_REQUIRED", "School context required", 400);
    }
    const queuedSessionSchoolVersion = req.authMethod === "session"
      ? sessionSchoolId === schoolId ? sessionSchoolVersion : req.session?.schoolSessionVersion
      : undefined;
    release = await classpilotUsageAdmission.acquire(schoolId, controller.signal);
    const report = await runWithUsageCapacityOperation("usage_report", () => runClasspilotUsageExecution({
      schoolId, signal: controller.signal, deadlineAt,
    }, async () => {
      if (readClasspilotDigitalUsageMode() !== "on") {
        throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_UNAVAILABLE", "Not found", 404);
      }
      const actor = await authorizeClasspilotUsage({
        schoolId,
        userId: req.authUser!.id,
        credentialVersion: req.authMethod === "jwt" ? req.jwtPayload?.authVersion : req.session?.authVersion,
        sessionSchoolVersion: queuedSessionSchoolVersion,
      });
      const value = await getClasspilotDigitalUsage({
        schoolId, scope: query.scope, id: query.id, from: query.from, to: query.to,
      });
      if (query.format === "csv") {
        // Audit uses the same lease, after the read-only transaction commits.
        await logAuditStrict({
          schoolId, ...actor,
          action: "classpilot.usage.export",
          entityType: `classpilot_usage_${query.scope}`,
          entityId: query.id ?? schoolId,
          metadata: {
            scope: query.scope, from: value.range.from, to: value.range.to,
            presentedDays: value.byDay.length, dataState: value.dataState,
          },
        });
      }
      return value;
    }));
    // No DB lease or admission permit is held during formatting/network send.
    release();
    release = undefined;
    if (controller.signal.aborted || res.headersSent || res.destroyed) return;
    check();
    if (query.format === "csv") {
      const csv = classpilotDigitalUsageCsv(report);
      check();
      res.set({
        "Cache-Control": "no-store, private",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${classpilotDigitalUsageCsvFileName(report)}"`,
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(csv);
    }
    res.set("Cache-Control", "no-store, private");
    return res.json(report);
  } catch (error) {
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    if (error instanceof ClasspilotUsageBusyError) return sendBusy();
    if (error instanceof ClasspilotDigitalUsageError) {
      if (error.status === 401 && req.authMethod === "session") {
        try {
          await new Promise<void>((resolve, reject) => req.session.destroy(failure => failure ? reject(failure) : resolve()));
        } catch (failure) {
          if (!res.headersSent && !res.destroyed) next(failure);
          return;
        }
        if (res.headersSent || res.destroyed || res.writableEnded) return;
        clearSessionCookie(res);
      }
      res.set("Cache-Control", "no-store, private");
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    next(error);
  } finally {
    release?.();
  }
});

export default router;
