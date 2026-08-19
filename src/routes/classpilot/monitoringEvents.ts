import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import { logAudit } from "../../services/audit.js";
import {
  getTeachingSessionByIdAndSchool,
  getSupervisionContextByIdAndSchool,
  insertClasspilotMonitoringEventForResolvedScope,
  isAuthorizedClasspilotSessionStaff,
  isAuthorizedClasspilotSupervisionStaff,
  listClasspilotMonitoringEvents,
  readAuthorizedClasspilotSessionReport,
  type ClasspilotMonitoringScope,
} from "../../services/storage.js";
import { getSettingsForSchool } from "../../services/storage.js";
import { sanitizeExtensionMonitoringEvent } from "../../services/classpilotMonitoringEventSanitizer.js";
import { classpilotRetentionExpiresAt } from "../../util/classpilotRetention.js";
import {
  decodeClasspilotEventCursor,
  encodeClasspilotEventCursor,
  formulaSafeCsvCell,
} from "../../util/classpilotEventCursor.js";

const router = Router();

const deviceEventLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  // Device authentication runs first, so rate-limit each cryptographically
  // bound Chromebook rather than a whole school sharing one NAT address.
  keyGenerator: (_req, res) =>
    `device:${String(res.locals.schoolId || "unknown-school")}:${String(res.locals.deviceId || "unknown-device")}`,
});

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "teacher"),
] as const;

const EVENT_TYPES = new Set([
  "tab_changed", "navigation_changed", "navigation_blocked",
  "monitoring_state_changed", "restriction_state_applied",
  "restriction_state_failed", "restriction_state_cleared",
  "student_session_started", "student_session_ended", "monitoring_gap",
]);

function isAdmin(req: any, res: any): boolean {
  const role = res.locals.membershipRole as string | undefined;
  return !!req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
}

async function authorizeSession(req: any, res: any, teachingSessionId: string): Promise<boolean> {
  if (isAdmin(req, res)) return !!(await getTeachingSessionByIdAndSchool(teachingSessionId, res.locals.schoolId));
  return isAuthorizedClasspilotSessionStaff(res.locals.schoolId, teachingSessionId, req.authUser!.id);
}

async function authorizeContext(req: any, res: any, contextId: string): Promise<boolean> {
  const context = await getSupervisionContextByIdAndSchool(res.locals.schoolId, contextId);
  if (!context) return false;
  return isAdmin(req, res)
    || isAuthorizedClasspilotSupervisionStaff(res.locals.schoolId, contextId, req.authUser!.id);
}

function publicEvent(row: Awaited<ReturnType<typeof listClasspilotMonitoringEvents>>[number]) {
  const event = row.event;
  return {
    id: event.id,
    studentId: event.studentId,
    studentName: row.studentName,
    type: event.eventType,
    origin: event.origin,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    domain: event.normalizedDomain,
    path: event.sanitizedPath,
    title: event.title,
    metadata: event.metadata,
  };
}

function parseEventTypes(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  return values.length > 0 && values.every((item) => EVENT_TYPES.has(item)) ? values : undefined;
}

router.post("/device/events", requireDeviceAuth, requireClasspilotEntitlement, deviceEventLimiter, async (req, res, next) => {
  try {
    const values = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!values || values.length < 1 || values.length > 50) {
      return res.status(400).json({ error: "events must contain 1 through 50 items" });
    }
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const activeStudentSession = res.locals.activeStudentSession as {
      id?: string;
      startedAt?: Date | string;
      endedAt?: Date | string | null;
    } | undefined;
    const settings = await getSettingsForSchool(schoolId);
    const now = new Date();
    const results: Array<{ sourceEventId: string | null; status: "stored" | "duplicate" | "not_retained" }> = [];

    for (const value of values) {
      const sanitized = sanitizeExtensionMonitoringEvent(value, now);
      if (!sanitized) {
        results.push({
          sourceEventId: value && typeof value === "object" && "sourceEventId" in value
            ? String((value as any).sourceEventId).slice(0, 128)
            : null,
          status: "not_retained",
        });
        continue;
      }
      const authenticatedStartedAt = activeStudentSession?.startedAt
        ? new Date(activeStudentSession.startedAt)
        : null;
      const authenticatedEndedAt = activeStudentSession?.endedAt
        ? new Date(activeStudentSession.endedAt)
        : null;
      if (
        activeStudentSession?.id !== studentSessionId
        || !authenticatedStartedAt
        || !Number.isFinite(authenticatedStartedAt.getTime())
        || sanitized.occurredAt.getTime() < authenticatedStartedAt.getTime() - 5 * 60_000
        || (authenticatedEndedAt && sanitized.occurredAt >= authenticatedEndedAt)
      ) {
        results.push({ sourceEventId: sanitized.sourceEventId, status: "not_retained" });
        continue;
      }
      const claimedTeachingSessionId = value && typeof value === "object"
        ? String((value as any).teachingSessionId || "").trim() || null
        : null;
      const claimedSupervisionContextId = value && typeof value === "object"
        ? String((value as any).supervisionContextId || "").trim() || null
        : null;
      if (Boolean(claimedTeachingSessionId) === Boolean(claimedSupervisionContextId)) {
        results.push({ sourceEventId: sanitized.sourceEventId, status: "not_retained" });
        continue;
      }
      const retentionExpiresAt = classpilotRetentionExpiresAt(sanitized.occurredAt, settings?.retentionHours);
      if (retentionExpiresAt.getTime() <= now.getTime()) {
        results.push({ sourceEventId: sanitized.sourceEventId, status: "not_retained" });
        continue;
      }
      const status = await insertClasspilotMonitoringEventForResolvedScope({
        schoolId,
        studentId,
        deviceId,
        studentSessionId,
        claimedTeachingSessionId,
        claimedSupervisionContextId,
        sourceEventId: sanitized.sourceEventId,
        schemaVersion: 1,
        origin: "extension",
        eventType: sanitized.eventType,
        occurredAt: sanitized.occurredAt,
        receivedAt: now,
        normalizedDomain: sanitized.normalizedDomain,
        sanitizedPath: sanitized.sanitizedPath,
        title: sanitized.title,
        metadata: sanitized.metadata,
        retentionExpiresAt,
      });
      results.push({ sourceEventId: sanitized.sourceEventId, status });
    }
    res.json({ results });
  } catch (error) {
    next(error);
  }
});

async function eventList(req: any, res: any, next: any, scope: ClasspilotMonitoringScope) {
  try {
    const authorized = scope.kind === "teaching_session"
      ? await authorizeSession(req, res, scope.id)
      : await authorizeContext(req, res, scope.id);
    if (!authorized) return res.status(404).json({ error: "Not found" });
    const requestedTypes = typeof req.query.type === "string" ? req.query.type : req.query.types;
    const eventTypes = parseEventTypes(requestedTypes);
    if (requestedTypes && !eventTypes) return res.status(400).json({ error: "Invalid event type filter" });
    const cursor = req.query.cursor ? decodeClasspilotEventCursor(req.query.cursor) : undefined;
    if (req.query.cursor && !cursor) return res.status(400).json({ error: "Invalid cursor" });
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit || "100"), 10) || 100, 250));
    const rows = await listClasspilotMonitoringEvents({
      schoolId: res.locals.schoolId,
      scope,
      studentId: typeof req.query.studentId === "string" ? req.query.studentId : undefined,
      eventTypes,
      before: cursor,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.event;
    res.set("Cache-Control", "no-store, private");
    res.json({
      events: page.map(publicEvent),
      nextCursor: rows.length > limit && last
        ? encodeClasspilotEventCursor({ occurredAt: last.occurredAt, id: last.id })
        : null,
    });
  } catch (error) {
    next(error);
  }
}

router.get("/teaching-sessions/:id/events", ...staffAuth, (req, res, next) =>
  eventList(req, res, next, { kind: "teaching_session", id: String(req.params.id || "") })
);

router.get("/supervision-contexts/:id/events", ...staffAuth, (req, res, next) =>
  eventList(req, res, next, { kind: "supervision_context", id: String(req.params.id || "") })
);

router.get("/teaching-sessions/:id/report", ...staffAuth, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store, private");
    const teachingSessionId = String(req.params.id || "");
    const schoolId = res.locals.schoolId as string;
    const reportRead = await readAuthorizedClasspilotSessionReport({
      schoolId,
      teachingSessionId,
      staffId: req.authUser!.id,
      isAdmin: isAdmin(req, res),
      now: new Date(),
    });
    if (reportRead.status !== "available") {
      if (reportRead.status === "expired") {
        return res.status(410).json({ error: "Session summary expired", code: "SUMMARY_EXPIRED" });
      }
      return res.status(404).json({ error: "Not found" });
    }
    const { report, studentReports } = reportRead;
    if (report.state === "pending" || report.state === "materializing") {
      return res.status(202).json({ state: "pending", retryAfterSeconds: 5 });
    }
    if (report.state === "failed") {
      return res.status(200).json({ state: "failed", error: "Session summary could not be generated" });
    }
    return res.json({
      state: "ready",
      report: {
        teachingSessionId: report.teachingSessionId,
        windowStart: report.windowStart,
        windowEnd: report.windowEnd,
        timezone: report.timezone,
        coverageAlgorithmVersion: report.coverageAlgorithmVersion,
        totals: {
          roster: report.rosterCount,
          eligible: report.eligibleStudentCount,
          complete: report.completeCount,
          partial: report.partialCount,
          none: report.noneCount,
          notExpected: report.notExpectedCount,
          unavailable: report.unavailableCount,
          eligibleSeconds: report.totalEligibleSeconds,
          observedSeconds: report.totalObservedSeconds,
          gapSeconds: report.totalGapSeconds,
        },
        students: studentReports.map((student) => ({
          studentId: student.studentId,
          studentName: student.studentNameSnapshot,
          status: student.status,
          eligibleSeconds: student.eligibleSeconds,
          observedSeconds: student.observedSeconds,
          gapSeconds: student.gapSeconds,
          coveragePercent: student.coveragePercent,
          heartbeatCount: student.heartbeatCount,
          firstObservedAt: student.firstObservedAt,
          lastObservedAt: student.lastObservedAt,
          gapIntervals: Array.isArray(student.gapIntervals)
            ? student.gapIntervals.map((value) => {
                const gap = value && typeof value === "object" ? value as Record<string, unknown> : {};
                return {
                  start: gap.start,
                  end: gap.end,
                  durationSeconds: gap.durationSeconds,
                  cause: "unknown",
                };
              })
            : [],
          eventCounts: student.eventCounts,
          topDomains: student.topDomains,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/teaching-sessions/:id/events/export.csv", ...staffAuth, async (req, res, next) => {
  try {
    const teachingSessionId = String(req.params.id || "");
    if (!(await authorizeSession(req, res, teachingSessionId))) {
      return res.status(404).json({ error: "Not found" });
    }
    const schoolId = res.locals.schoolId as string;
    const rows = await listClasspilotMonitoringEvents({
      schoolId,
      scope: { kind: "teaching_session", id: teachingSessionId },
      studentId: typeof req.query.studentId === "string" ? req.query.studentId : undefined,
      limit: 50_001,
    });
    if (rows.length > 50_000) {
      return res.status(413).json({ error: "Export exceeds 50,000 rows", code: "EXPORT_TOO_LARGE" });
    }
    await logAudit({
      schoolId: res.locals.schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "classpilot.monitoring_events.export",
      entityType: "teaching_session",
      entityId: teachingSessionId,
      metadata: { rowCount: rows.length },
    });
    const header = ["Occurred At", "Student ID", "Student", "Type", "Origin", "Domain", "Path", "Title", "Details"];
    const csvRows = [header, ...rows.map((row) => [
      row.event.occurredAt.toISOString(),
      row.event.studentId,
      row.studentName,
      row.event.eventType,
      row.event.origin,
      row.event.normalizedDomain || "",
      row.event.sanitizedPath || "",
      row.event.title || "",
      JSON.stringify(row.event.metadata || {}),
    ])];
    res.set({
      "Cache-Control": "no-store, private",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="classpilot-monitoring-${teachingSessionId}.csv"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(`\uFEFF${csvRows.map((row) => row.map(formulaSafeCsvCell).join(",")).join("\r\n")}`);
  } catch (error) {
    next(error);
  }
});

export default router;
