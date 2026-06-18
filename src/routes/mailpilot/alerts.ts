import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getSchoolById,
  listEmailAlertsForSchool,
  getEmailAlertById,
  updateEmailAlertReview,
  getEmailAlertStats,
  getStudentById,
  getMailpilotWatchesBySchool,
  createStudentTimelineEvent,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

// Gate every endpoint on the add-on flag (not a full license — a boolean on schools)
async function requireEmailMonitoringEnabled(req: any, res: any, next: any) {
  if (req.authUser?.isSuperAdmin) return next();
  const schoolId = res.locals.schoolId;
  const school = await getSchoolById(schoolId);
  if (!school?.mailpilotEntitled) {
    return res.status(403).json({ error: "MailPilot is not enabled for this school" });
  }
  if (!school?.classpilotEmailMonitoring) {
    return res.status(403).json({ error: "Email monitoring not enabled for this school" });
  }
  next();
}

// GET /api/mailpilot/alerts - list alerts for this school
router.get("/alerts", ...auth, requireEmailMonitoringEnabled, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200);
    const offset = parseInt(String(req.query.offset || "0"), 10) || 0;
    const reviewStatus = req.query.reviewStatus as any;
    const severity = req.query.severity as string | undefined;
    const safetyAlert = req.query.safetyAlert as string | undefined;
    const studentId = req.query.studentId as string | undefined;
    const sinceStr = req.query.since as string | undefined;
    const since = sinceStr ? new Date(sinceStr) : undefined;

    const rows = await listEmailAlertsForSchool(schoolId, {
      limit,
      offset,
      reviewStatus: reviewStatus || "all",
      severity,
      safetyAlert,
      studentId,
      since: since && !isNaN(since.getTime()) ? since : undefined,
    });

    // Enrich with student name
    const alerts = await Promise.all(rows.map(async (a) => {
      const student = await getStudentById(a.studentId);
      return {
        ...a,
        studentName: student ? `${student.firstName || ""} ${student.lastName || ""}`.trim() : null,
      };
    }));

    return res.json({ alerts, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/mailpilot/alerts/stats - summary counts for dashboard header
router.get("/alerts/stats", ...auth, requireEmailMonitoringEnabled, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [d24, d7, d30] = await Promise.all([
      getEmailAlertStats(schoolId, since24h),
      getEmailAlertStats(schoolId, since7d),
      getEmailAlertStats(schoolId, since30d),
    ]);
    const watches = await getMailpilotWatchesBySchool(schoolId);

    return res.json({
      last24h: d24,
      last7d: d7,
      last30d: d30,
      mailboxesMonitored: watches.filter((w) => w.status === "active").length,
      mailboxesWithErrors: watches.filter((w) => w.status === "error").length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/mailpilot/alerts/:id - full detail
router.get("/alerts/:id", ...auth, requireEmailMonitoringEnabled, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const alert = await getEmailAlertById(String(req.params.id));
    if (!alert || alert.schoolId !== schoolId) {
      return res.status(404).json({ error: "Alert not found" });
    }
    const student = await getStudentById(alert.studentId);
    return res.json({
      alert: {
        ...alert,
        studentName: student ? `${student.firstName || ""} ${student.lastName || ""}`.trim() : null,
        studentGradeLevel: student?.gradeLevel || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mailpilot/alerts/:id/review - mark reviewed
router.patch("/alerts/:id/review", ...auth, requireEmailMonitoringEnabled, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const alert = await getEmailAlertById(String(req.params.id));
    if (!alert || alert.schoolId !== schoolId) {
      return res.status(404).json({ error: "Alert not found" });
    }
    const { reviewStatus, reviewNote } = req.body as {
      reviewStatus?: string;
      reviewNote?: string;
    };
    if (!["confirmed", "dismissed", "escalated"].includes(reviewStatus || "")) {
      return res.status(400).json({ error: "reviewStatus must be confirmed | dismissed | escalated" });
    }
    const updated = await updateEmailAlertReview(alert.id, {
      reviewStatus: reviewStatus as "confirmed" | "dismissed" | "escalated",
      reviewedBy: req.authUser!.id,
      reviewNote,
    });
    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: `mailpilot_alert_${reviewStatus}`,
      entityType: "email_alert",
      entityId: alert.id,
      schoolId,
      metadata: { studentEmail: alert.studentEmail, safetyAlert: alert.safetyAlert, reviewNote },
    });
    await createStudentTimelineEvent({
      schoolId,
      studentId: alert.studentId,
      eventType: "mailpilot_review",
      sourceType: "mailpilot",
      sourceId: alert.id,
      title: `Email alert ${reviewStatus}`,
      summary: reviewNote || null,
      actorUserId: req.authUser!.id,
      metadata: { reviewStatus, reviewNote, safetyAlert: alert.safetyAlert },
    });
    return res.json({ alert: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
