import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db from "../../db.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getConnectedStudentDeviceIds } from "../../realtime/ws-broadcast.js";
import { getSchoolDeviceStatuses } from "../../realtime/student-statuses.js";
import { studentDevices } from "../../schema/classpilot.js";
import { dismissalQueue, dismissalSessions } from "../../schema/gopilot.js";
import { importRuns } from "../../schema/shared.js";
import {
  createClasspilotAiDecision,
  createEvidenceArtifact,
  createStudentTimelineEvent,
  getApprovedParentLinksForStudent,
  getClasspilotAiDecisionById,
  getDailyUsageForStudent,
  getEvidenceArtifactById,
  getClassroomCoursesBySchool,
  getDevicesBySchool,
  getEmailDomain,
  getGoogleOAuthToken,
  getGroupStudents,
  getGroupsByTeacher,
  getMailpilotWatchesBySchool,
  getOrCreateSafetyCaseForStudent,
  getPassHistory,
  getSchoolById,
  getSettingsForSchool,
  getStaffEmailDomainMismatches,
  getStudentAttendance,
  getStudentById,
  getStudentsByIds,
  getStudentsBySchool,
  listClasspilotAiDecisions,
  listEmailAlertsForSchool,
  listEvidenceArtifactsForStudent,
  listOpenSafetyCasesForSchool,
  listStudentTimelineEvents,
  updateClasspilotAiDecisionReview,
  upsertSettings,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";

const router = Router();

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

const adminAuth = [...staffAuth, requireRole("admin", "school_admin")] as const;

const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
];
const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
];

function roleFrom(res: any, req: any): string {
  if (req.authUser?.isSuperAdmin) return "super_admin";
  return String(res.locals.membershipRole || "");
}

function isAdminRole(role: string): boolean {
  return ["admin", "school_admin", "super_admin"].includes(role);
}

function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function studentName(student: any): string {
  return [student?.firstName, student?.lastName].filter(Boolean).join(" ") || student?.email || "Unknown student";
}

function csvEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
  ].join("\n");
}

async function canViewStudent(req: any, res: any, studentId: string): Promise<{ allowed: boolean; student?: any; role: string }> {
  const role = roleFrom(res, req);
  const schoolId = res.locals.schoolId!;
  const student = await getStudentById(studentId);
  if (!student || student.schoolId !== schoolId) return { allowed: false, role };
  if (isAdminRole(role) || role === "office_staff") return { allowed: true, student, role };
  if (role === "teacher") {
    const groups = await getGroupsByTeacher(req.authUser!.id);
    for (const group of groups) {
      if (group.schoolId !== schoolId) continue;
      const members = await getGroupStudents(group.id);
      if (members.some((m) => m.student.id === studentId)) return { allowed: true, student, role };
    }
  }
  return { allowed: false, student, role };
}

function redactTimelineEvent(event: any, role: string): any {
  if (isAdminRole(role)) return event;
  if (event.sourceType === "mailpilot" || event.source_type === "mailpilot") {
    return {
      ...event,
      title: "Email safety alert",
      summary: "Email details hidden for this role.",
      metadata: {
        safetyAlert: event.metadata?.safetyAlert,
        severity: event.metadata?.severity,
        redacted: true,
      },
    };
  }
  return event;
}

function normalizeEvent(row: any): any {
  return {
    id: row.id,
    schoolId: row.schoolId,
    studentId: row.studentId,
    caseId: row.caseId || null,
    eventType: row.eventType,
    sourceType: row.sourceType,
    sourceId: row.sourceId || null,
    title: row.title,
    summary: row.summary || null,
    severity: row.severity || null,
    actorUserId: row.actorUserId || null,
    metadata: row.metadata || {},
    occurredAt: row.occurredAt || row.createdAt,
    persisted: true,
  };
}

async function buildTimeline(options: {
  schoolId: string;
  studentId: string;
  from?: Date;
  to?: Date;
  types?: string[];
  caseId?: string;
  role: string;
  fullEmail?: boolean;
}) {
  const events: any[] = [];
  const typeSet = options.types?.length ? new Set(options.types) : null;
  const include = (type: string) => !typeSet || typeSet.has(type);

  // Cap the queryable window. Some downstream sources (attendance, pass history)
  // scan the full range without tight LIMITs, and an omitted `from` otherwise
  // defaults to 2020-01-01, so an unbounded range is a DoS vector.
  const MAX_RANGE_DAYS = 180;
  const rangeEnd = options.to ?? new Date();
  const minStart = new Date(rangeEnd.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (!options.from || options.from.getTime() < minStart.getTime()) {
    options = { ...options, from: minStart };
  }

  const persisted = await listStudentTimelineEvents({
    schoolId: options.schoolId,
    studentId: options.studentId,
    from: options.from,
    to: options.to,
    types: options.types,
    caseId: options.caseId,
    limit: 300,
  });
  events.push(...persisted.map(normalizeEvent));

  if (include("ai_decision")) {
    const decisions = await listClasspilotAiDecisions({
      schoolId: options.schoolId,
      studentId: options.studentId,
      from: options.from,
      to: options.to,
      limit: 150,
    });
    events.push(...decisions.map((d) => ({
      id: `ai:${d.id}`,
      eventType: "ai_decision",
      sourceType: "classpilot_ai",
      sourceId: d.id,
      title: d.safetyAlert ? `AI safety alert: ${d.safetyAlert}` : `AI classified: ${d.category || "unknown"}`,
      summary: d.reasoning || d.url || null,
      severity: d.safetyAlert ? "high" : null,
      metadata: d,
      occurredAt: d.createdAt,
      persisted: false,
    })));
  }

  if (include("mailpilot_alert")) {
    const alerts = await listEmailAlertsForSchool(options.schoolId, {
      studentId: options.studentId,
      since: options.from,
      limit: 150,
      reviewStatus: "all",
    });
    events.push(...alerts
      .filter((a) => !options.to || a.alertedAt <= options.to)
      .map((a) => ({
        id: `mail:${a.id}`,
        eventType: "mailpilot_alert",
        sourceType: "mailpilot",
        sourceId: a.id,
        title: `Email safety alert: ${a.safetyAlert || (a.bullying === "true" ? "bullying" : "review")}`,
        summary: options.fullEmail || isAdminRole(options.role) ? a.snippet : "Email details hidden for this role.",
        severity: a.severity,
        metadata: {
          safetyAlert: a.safetyAlert,
          severity: a.severity,
          direction: a.direction,
          subject: options.fullEmail || isAdminRole(options.role) ? a.subject : undefined,
          sender: options.fullEmail || isAdminRole(options.role) ? a.sender : undefined,
          reviewStatus: a.reviewStatus,
        },
        occurredAt: a.alertedAt,
        persisted: false,
      })));
  }

  if (include("attendance")) {
    const start = options.from?.toISOString().slice(0, 10) || "2020-01-01";
    const end = options.to?.toISOString().slice(0, 10) || new Date().toISOString().slice(0, 10);
    const attendance = await getStudentAttendance(options.studentId, start, end);
    events.push(...attendance.map((a) => ({
      id: `attendance:${a.id}`,
      eventType: "attendance",
      sourceType: "attendance",
      sourceId: a.id,
      title: `Attendance marked ${a.status}`,
      summary: a.reason || a.notes || null,
      severity: null,
      metadata: a,
      occurredAt: a.createdAt,
      persisted: false,
    })));
  }

  if (include("pass")) {
    const passes = await getPassHistory(options.schoolId, {
      studentId: options.studentId,
      startDate: options.from,
      endDate: options.to,
    });
    events.push(...passes.map((p) => ({
      id: `pass:${p.id}`,
      eventType: "pass",
      sourceType: "passpilot",
      sourceId: p.id,
      title: `Hall pass ${p.status}: ${p.destination}`,
      summary: p.customDestination || p.notes || null,
      severity: null,
      metadata: p,
      occurredAt: p.issuedAt,
      persisted: false,
    })));
  }

  if (include("dismissal")) {
    const rows = await db
      .select({ queue: dismissalQueue, session: dismissalSessions })
      .from(dismissalQueue)
      .innerJoin(dismissalSessions, eq(dismissalQueue.sessionId, dismissalSessions.id))
      .where(
        and(
          eq(dismissalQueue.studentId, options.studentId),
          eq(dismissalSessions.schoolId, options.schoolId),
          options.from ? sql`${dismissalQueue.createdAt} >= ${options.from}` : sql`true`,
          options.to ? sql`${dismissalQueue.createdAt} <= ${options.to}` : sql`true`
        )
      )
      .orderBy(desc(dismissalQueue.createdAt))
      .limit(100);
    events.push(...rows.map((r) => ({
      id: `dismissal:${r.queue.id}`,
      eventType: "dismissal",
      sourceType: "gopilot",
      sourceId: r.queue.id,
      title: `Dismissal ${r.queue.status}`,
      summary: r.queue.guardianName || r.queue.checkInMethod || null,
      severity: null,
      metadata: { ...r.queue, sessionDate: r.session.date },
      occurredAt: r.queue.createdAt,
      persisted: false,
    })));
  }

  return events
    .map((e) => redactTimelineEvent(e, options.role))
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 500);
}

function issue(status: "pass" | "warn" | "fail", category: string, title: string, detail: string, fixPath?: string) {
  return { status, category, title, detail, fixPath };
}

async function buildReadinessPayload(req: any, res: any) {
  const schoolId = res.locals.schoolId!;
  const [school, settings, token, students, dbDevices, courses, watches, recentImports, cases, staffDomainMismatches] = await Promise.all([
    getSchoolById(schoolId),
    getSettingsForSchool(schoolId),
    getGoogleOAuthToken(req.authUser!.id),
    getStudentsBySchool(schoolId),
    getDevicesBySchool(schoolId),
    getClassroomCoursesBySchool(schoolId),
    getMailpilotWatchesBySchool(schoolId),
    db.select().from(importRuns).where(eq(importRuns.schoolId, schoolId)).orderBy(desc(importRuns.createdAt)).limit(5),
    listOpenSafetyCasesForSchool(schoolId, 20),
    getStaffEmailDomainMismatches(schoolId),
  ]);

  const now = Date.now();
  const scopes = new Set((token?.scope || "").split(/\s+/).filter(Boolean));
  const schoolDomain = school?.domain?.trim().toLowerCase() || null;
  const connectedDomain = token?.connectedDomain || getEmailDomain(token?.connectedEmail || null);
  const googleDomainVerified = !!token && !!schoolDomain && !!connectedDomain && connectedDomain === schoolDomain;
  const googleRequiresReconnect = !!token && (!token.connectedEmail || !connectedDomain);
  const realtime = getSchoolDeviceStatuses(schoolId);
  const connected = getConnectedStudentDeviceIds(schoolId);
  const realtimeByDevice = new Map(realtime.map((s) => [s.deviceId, s]));
  const studentMappings = students.length
    ? await db.select().from(studentDevices).where(inArray(studentDevices.studentId, students.map((s) => s.id)))
    : [];

  const staleDevices = dbDevices.filter((d) => {
    const rt = realtimeByDevice.get(d.deviceId);
    const last = rt?.lastSeenAt || d.lastSeenAt?.getTime?.() || 0;
    return last === 0 || now - last > 48 * 60 * 60 * 1000;
  });
  const screenshotFailures = dbDevices.filter((d) => {
    const rt = realtimeByDevice.get(d.deviceId);
    const health: any = rt?.screenshotHealth || d.lastScreenshotHealth;
    return health?.lastError || (health?.attempts > 0 && !health?.successes);
  });
  const missingEmail = students.filter((s) => !s.email || !s.emailLc);
  const unmappedStudents = students.filter((s) => !studentMappings.some((m) => m.studentId === s.id));

  const issues = [
    issue(token ? "pass" : "fail", "Google", "Google account connected", token ? "OAuth token found for this admin." : "Reconnect Google from the admin setup flow.", "/classpilot/students"),
    issue(schoolDomain ? "pass" : "fail", "Google", "School Workspace domain", schoolDomain ? `School domain is ${schoolDomain}.` : "Set the school Google Workspace domain before imports.", "/super-admin"),
    issue(googleDomainVerified ? "pass" : "fail", "Google", "Connected Google domain", !token ? "Reconnect Google from the admin setup flow." : googleRequiresReconnect ? "Reconnect Google so SchoolPilot can verify the connected account domain." : googleDomainVerified ? `Connected domain ${connectedDomain} matches this school.` : `Connected domain ${connectedDomain || "unknown"} does not match ${schoolDomain || "the school domain"}.`, "/classpilot/students"),
    issue(CLASSROOM_SCOPES.every((s) => scopes.has(s)) ? "pass" : "fail", "Google", "Classroom roster scopes", CLASSROOM_SCOPES.filter((s) => !scopes.has(s)).join(", ") || "All Classroom scopes granted.", "/classpilot/students"),
    issue(DIRECTORY_SCOPES.every((s) => scopes.has(s)) ? "pass" : "warn", "Google", "Workspace Directory scopes", DIRECTORY_SCOPES.filter((s) => !scopes.has(s)).join(", ") || "All Directory scopes granted.", "/classpilot/students"),
    issue(staffDomainMismatches.length === 0 ? "pass" : "fail", "Staff", "Staff email domain match", staffDomainMismatches.length === 0 ? "All staff emails match the school Workspace domain." : `${staffDomainMismatches.length} staff account(s) use the wrong or unverifiable domain.`, "/admin/users"),
    issue(courses.length > 0 ? "pass" : "warn", "Roster", "Classroom sync history", courses.length > 0 ? `${courses.length} Classroom course(s) synced.` : "No Classroom courses have been synced yet.", "/classpilot/admin/classes"),
    issue(recentImports.length > 0 ? "pass" : "warn", "Roster", "Import run log", recentImports.length > 0 ? "Recent import outcomes are available." : "No import runs recorded yet.", "/classpilot/students"),
    issue(missingEmail.length === 0 ? "pass" : "fail", "Roster", "Student identity emails", missingEmail.length === 0 ? "Every student has an email and emailLc." : `${missingEmail.length} student(s) need email repair.`, "/classpilot/students"),
    issue(unmappedStudents.length === 0 ? "pass" : "warn", "Devices", "Student device mappings", unmappedStudents.length === 0 ? "All students have a known device mapping." : `${unmappedStudents.length} student(s) have no seen device yet.`, "/classpilot/roster"),
    issue(staleDevices.length === 0 ? "pass" : "warn", "Devices", "Stale devices", staleDevices.length === 0 ? "No stale devices older than 48 hours." : `${staleDevices.length} device(s) have not checked in recently.`, "/classpilot/roster"),
    issue(screenshotFailures.length === 0 ? "pass" : "warn", "Screenshots", "Screenshot health", screenshotFailures.length === 0 ? "No screenshot errors reported." : `${screenshotFailures.length} device(s) reported screenshot issues.`, "/classpilot"),
    issue(school?.classpilotEmailMonitoring ? (watches.filter((w) => w.status === "active").length > 0 ? "pass" : "warn") : "warn", "MailPilot", "Gmail safety monitoring", school?.classpilotEmailMonitoring ? `${watches.filter((w) => w.status === "active").length} active Gmail watch(es).` : "MailPilot is not enabled for this school.", "/classpilot/email-monitoring"),
    issue(settings?.aiSafetyEmailsEnabled !== false ? "pass" : "warn", "Safety", "AI safety email alerts", settings?.aiSafetyEmailsEnabled !== false ? "Safety emails are enabled." : "Safety emails are disabled.", "/classpilot/settings"),
  ];

  const counts = issues.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    generatedAt: new Date().toISOString(),
    school: school ? { id: school.id, name: school.name, domain: school.domain } : null,
    summary: {
      pass: counts.pass || 0,
      warn: counts.warn || 0,
      fail: counts.fail || 0,
      students: students.length,
      devices: dbDevices.length,
      connectedDevices: connected.size,
      openSafetyCases: cases.length,
    },
    issues,
    details: {
      recentImports,
      staleDevices: staleDevices.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, lastSeenAt: d.lastSeenAt })),
      screenshotFailures: screenshotFailures.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, health: d.lastScreenshotHealth })),
      missingEmail: missingEmail.map((s) => ({ id: s.id, name: studentName(s), email: s.email })),
      unmappedStudents: unmappedStudents.map((s) => ({ id: s.id, name: studentName(s), email: s.email })),
      google: {
        connectedEmail: token?.connectedEmail || null,
        connectedDomain,
        schoolDomain,
        domainVerified: googleDomainVerified,
        requiresReconnect: googleRequiresReconnect,
      },
      staffDomainMismatches,
      mailpilot: {
        enabled: !!school?.classpilotEmailMonitoring,
        activeWatches: watches.filter((w) => w.status === "active").length,
        errorWatches: watches.filter((w) => w.status === "error").length,
      },
    },
  };
}

// GET /api/classpilot/it-readiness
router.get("/it-readiness", ...adminAuth, async (req, res, next) => {
  try {
    return res.json(await buildReadinessPayload(req, res));
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/it-readiness/export.csv
router.get("/it-readiness/export.csv", ...adminAuth, async (req, res, next) => {
  try {
    const payload = await buildReadinessPayload(req, res);
    const rows = (payload?.issues || []).map((i: any) => ({
      status: i.status,
      category: i.category,
      title: i.title,
      detail: i.detail,
      fixPath: i.fixPath,
    }));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=classpilot-it-readiness.csv");
    return res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/ai-decisions
router.get("/ai-decisions", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const studentId = req.query.studentId as string | undefined;
    // Without a studentId this lists the whole school's AI safety decisions —
    // restrict that to admins. Teachers/office_staff must scope to a student
    // they're authorized to view (enforced by canViewStudent below).
    if (studentId) {
      const access = await canViewStudent(req, res, studentId);
      if (!access.allowed) return res.status(403).json({ error: "Insufficient permissions" });
    } else if (!isAdminRole(roleFrom(res, req))) {
      return res.status(400).json({ error: "studentId is required" });
    }
    const decisions = await listClasspilotAiDecisions({
      schoolId,
      studentId,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
      limit: 200,
    });
    return res.json({ decisions });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/ai-decisions/:id/review
router.patch("/ai-decisions/:id/review", ...adminAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const decision = await getClasspilotAiDecisionById(String(req.params.id), schoolId);
    if (!decision || decision.schoolId !== schoolId) return res.status(404).json({ error: "AI decision not found" });
    const { reviewStatus, reviewNote } = req.body;
    if (!["confirmed", "dismissed", "escalated"].includes(reviewStatus)) {
      return res.status(400).json({ error: "reviewStatus must be confirmed | dismissed | escalated" });
    }
    const updated = await updateClasspilotAiDecisionReview(decision.id, schoolId, {
      reviewStatus,
      reviewNote,
      reviewedBy: req.authUser!.id,
    });
    if (decision.studentId) {
      await createStudentTimelineEvent({
        schoolId,
        studentId: decision.studentId,
        eventType: "ai_review",
        sourceType: "classpilot_ai",
        sourceId: decision.id,
        title: `AI decision ${reviewStatus}`,
        summary: reviewNote || null,
        actorUserId: req.authUser!.id,
        metadata: { reviewStatus, reviewNote },
      });
    }
    return res.json({ decision: updated });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/students/:studentId/timeline
router.get("/students/:studentId/timeline", ...staffAuth, async (req, res, next) => {
  try {
    const access = await canViewStudent(req, res, String(req.params.studentId));
    if (!access.allowed) return res.status(403).json({ error: "Insufficient permissions" });
    const types = typeof req.query.types === "string" ? req.query.types.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const events = await buildTimeline({
      schoolId: res.locals.schoolId!,
      studentId: access.student.id,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
      caseId: req.query.caseId as string | undefined,
      types,
      role: access.role,
    });
    return res.json({ student: access.student, events });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/safety-cases
router.get("/safety-cases", ...adminAuth, async (_req, res, next) => {
  try {
    const cases = await listOpenSafetyCasesForSchool(res.locals.schoolId!, 100);
    const studentIds = [...new Set(cases.map((c) => c.studentId))];
    const students = await getStudentsByIds(studentIds);
    const studentMap = new Map(students.map((s) => [s.id, s]));
    const enriched = cases.map((c) => ({
      ...c,
      studentName: studentName(studentMap.get(c.studentId)),
    }));
    return res.json({ cases: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/evidence-packets
router.post("/evidence-packets", ...adminAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { studentId, caseId, from, to, includeFlags = {} } = req.body;
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) return res.status(404).json({ error: "Student not found" });
    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    const events = await buildTimeline({
      schoolId,
      studentId,
      caseId,
      from: fromDate,
      to: toDate,
      role: "admin",
      fullEmail: true,
    });
    const artifacts = await listEvidenceArtifactsForStudent({ schoolId, studentId, caseId, from: fromDate, to: toDate });
    const manifest = {
      packetGeneratedAt: new Date().toISOString(),
      generatedBy: req.authUser!.id,
      student: { id: student.id, name: studentName(student), email: student.email },
      range: { from: fromDate?.toISOString() || null, to: toDate?.toISOString() || null },
      includeFlags,
      events,
      artifacts,
    };
    const artifact = await createEvidenceArtifact({
      schoolId,
      studentId,
      caseId: caseId || null,
      sourceType: "evidence_packet",
      sourceId: caseId || studentId,
      artifactType: "zip_manifest",
      status: "available",
      label: `Evidence packet for ${studentName(student)}`,
      contentType: "application/zip",
      content: JSON.stringify(manifest),
      createdBy: req.authUser!.id,
      metadata: { eventCount: events.length, artifactCount: artifacts.length },
    });
    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "evidence_packet_created",
      entityType: "evidence_packet",
      entityId: artifact.id,
      schoolId,
      metadata: { studentId, caseId, eventCount: events.length },
    });
    return res.status(201).json({ packetId: artifact.id, eventCount: events.length, artifactCount: artifacts.length });
  } catch (err) {
    next(err);
  }
});

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateParts(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (date.getFullYear() - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(files: { name: string; content: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const { time, day } = zipDateParts();

  for (const file of files) {
    const name = Buffer.from(file.name);
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, content);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(content.length, 20);
    dir.writeUInt32LE(content.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(dir);
    offset += local.length + content.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

function safeFilename(value: unknown): string {
  return String(value || "artifact").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "artifact";
}

function artifactZipFiles(artifacts: any[]): { name: string; content: string | Buffer }[] {
  return artifacts.map((artifact, index) => {
    const base = safeFilename(`${index + 1}-${artifact.artifactType}-${artifact.label || artifact.id}`);
    if (artifact.status !== "available" || !artifact.content) {
      return {
        name: `artifacts/${base}.txt`,
        content: `${artifact.label || artifact.artifactType}: ${artifact.status || "unavailable"}`,
      };
    }
    if (artifact.contentType?.startsWith("image/")) {
      const ext = artifact.contentType.includes("png") ? "png" : artifact.contentType.includes("webp") ? "webp" : "jpg";
      const content = String(artifact.content);
      const base64 = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
      return { name: `artifacts/${base}.${ext}`, content: Buffer.from(base64, "base64") };
    }
    return { name: `artifacts/${base}.txt`, content: String(artifact.content) };
  });
}

// GET /api/classpilot/evidence-packets/:id/download
router.get("/evidence-packets/:id/download", ...adminAuth, async (req, res, next) => {
  try {
    const artifact = await getEvidenceArtifactById(String(req.params.id), res.locals.schoolId!);
    if (!artifact || artifact.schoolId !== res.locals.schoolId! || artifact.sourceType !== "evidence_packet") {
      return res.status(404).json({ error: "Evidence packet not found" });
    }
    const manifest = artifact.content ? JSON.parse(artifact.content) : {};
    const summaryManifest = {
      ...manifest,
      artifacts: (manifest.artifacts || []).map((a: any) => ({ ...a, content: a.content ? "[included in artifacts/]" : null })),
    };
    const timelineRows = (manifest.events || []).map((e: any) => ({
      occurredAt: e.occurredAt,
      eventType: e.eventType,
      sourceType: e.sourceType,
      title: e.title,
      summary: e.summary,
      severity: e.severity,
    }));
    const report = `<!doctype html><html><head><meta charset="utf-8"><title>Evidence Packet</title></head><body><h1>Evidence Packet</h1><p><strong>Student:</strong> ${htmlEscape(manifest.student?.name)}</p><p><strong>Generated:</strong> ${htmlEscape(manifest.packetGeneratedAt)}</p><table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>Time</th><th>Type</th><th>Title</th><th>Summary</th></tr></thead><tbody>${timelineRows.map((r: any) => `<tr><td>${htmlEscape(r.occurredAt)}</td><td>${htmlEscape(r.eventType)}</td><td>${htmlEscape(r.title)}</td><td>${htmlEscape(r.summary)}</td></tr>`).join("")}</tbody></table></body></html>`;
    const zip = createZip([
      { name: "summary.json", content: JSON.stringify(summaryManifest, null, 2) },
      { name: "timeline.csv", content: toCsv(timelineRows) },
      { name: "report.html", content: report },
      ...artifactZipFiles(manifest.artifacts || []),
    ]);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=classpilot-evidence-${artifact.id}.zip`);
    return res.send(zip);
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/parent-digests/preview?studentId=...
router.get("/parent-digests/preview", ...staffAuth, async (req, res, next) => {
  try {
    const studentId = String(req.query.studentId || "");
    const access = await canViewStudent(req, res, studentId);
    if (!access.allowed) return res.status(403).json({ error: "Insufficient permissions" });
    const schoolId = res.locals.schoolId!;
    const settings = await getSettingsForSchool(schoolId);
    const parents = await getApprovedParentLinksForStudent(studentId);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const usage = await getDailyUsageForStudent(studentId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    const passes = settings?.parentDigestIncludesPassDismissal !== false
      ? await getPassHistory(schoolId, { studentId, startDate: start, endDate: end })
      : [];
    const alerts = settings?.parentDigestIncludesSafety
      ? await listEmailAlertsForSchool(schoolId, { studentId, since: start, reviewStatus: "confirmed", limit: 20 })
      : [];
    const topDomains = new Map<string, number>();
    for (const day of usage) {
      for (const item of ((day.topDomains as any[]) || [])) {
        topDomains.set(item.domain, (topDomains.get(item.domain) || 0) + (item.seconds || 0));
      }
    }
    const digest = {
      enabled: !!settings?.parentTransparencyEnabled,
      cadence: settings?.parentDigestCadence || "weekly",
      student: { id: access.student.id, name: studentName(access.student), email: access.student.email },
      recipients: parents.map((p) => ({ parentId: p.parent.id, email: p.parent.email, name: studentName(p.parent), relationship: p.relationship })),
      period: { start: start.toISOString(), end: end.toISOString() },
      learningSummary: {
        daysActive: usage.length,
        totalSeconds: usage.reduce((sum, d) => sum + d.totalSeconds, 0),
        topDomains: [...topDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, seconds]) => ({ domain, seconds })),
      },
      passDismissalSummary: {
        passesIssued: passes.length,
        activeOrReturned: passes.filter((p) => ["active", "returned"].includes(p.status)).length,
      },
      safetySummary: settings?.parentDigestIncludesSafety ? {
        confirmedAlerts: alerts.length,
        categories: alerts.map((a) => a.safetyAlert || (a.bullying === "true" ? "bullying" : "review")),
      } : null,
      note: "No screenshots or raw browsing timelines are included in v1 parent transparency digests.",
    };
    return res.json({ digest });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/parent-digests/settings
router.get("/parent-digests/settings", ...staffAuth, async (_req, res, next) => {
  try {
    const settings = await getSettingsForSchool(res.locals.schoolId!);
    return res.json({
      settings: {
        parentTransparencyEnabled: !!settings?.parentTransparencyEnabled,
        parentDigestCadence: settings?.parentDigestCadence || "weekly",
        parentDigestIncludesSafety: !!settings?.parentDigestIncludesSafety,
        parentDigestIncludesPassDismissal: settings?.parentDigestIncludesPassDismissal !== false,
        parentDigestLastSentAt: settings?.parentDigestLastSentAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/parent-digests/settings", ...adminAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    // Preserve existing schoolName / wsSharedKey on update — res.locals.school
    // is never populated, so the old code corrupted these to "School"/"configured"
    // on every save. Only fall back to the real school name on first insert.
    const existing = await getSettingsForSchool(schoolId);
    const schoolName =
      existing?.schoolName || (await getSchoolById(schoolId))?.name || "School";
    const settings = await upsertSettings(schoolId, {
      schoolName,
      wsSharedKey: existing?.wsSharedKey || "configured",
      parentTransparencyEnabled: !!req.body.parentTransparencyEnabled,
      parentDigestCadence: "weekly",
      parentDigestIncludesSafety: !!req.body.parentDigestIncludesSafety,
      parentDigestIncludesPassDismissal: req.body.parentDigestIncludesPassDismissal !== false,
    });
    return res.json({ settings });
  } catch (err) {
    next(err);
  }
});

export async function recordBrowserSafetyTimeline(options: {
  schoolId: string;
  studentId: string;
  deviceId: string;
  heartbeatId: string;
  url: string;
  title?: string;
  classification: any;
}) {
  const safetyAlert = options.classification?.safetyAlert;
  if (!safetyAlert) return null;
  const safetyCase = await getOrCreateSafetyCaseForStudent({
    schoolId: options.schoolId,
    studentId: options.studentId,
    title: `ClassPilot safety alert: ${safetyAlert}`,
    severity: "high",
    summary: options.url,
    metadata: { source: "browser", safetyAlert },
  });
  const decision = await createClasspilotAiDecision({
    schoolId: options.schoolId,
    studentId: options.studentId,
    deviceId: options.deviceId,
    heartbeatId: options.heartbeatId,
    url: options.url,
    title: options.title || null,
    domain: options.classification?.domain || null,
    category: options.classification?.category || null,
    safetyAlert,
    confidence: options.classification?.confidence || null,
    reasoning: options.classification?.reasoning || null,
    matchedRule: options.classification?.source || null,
    actionTaken: "close-tab",
    teacherIntentSource: options.classification?.teacherIntentSource || null,
    reviewStatus: null,
    metadata: options.classification,
  });
  await createStudentTimelineEvent({
    schoolId: options.schoolId,
    studentId: options.studentId,
    caseId: safetyCase.id,
    eventType: "browser_safety_alert",
    sourceType: "classpilot_ai",
    sourceId: decision.id,
    title: `Browser safety alert: ${safetyAlert}`,
    summary: options.url,
    severity: "high",
    metadata: {
      deviceId: options.deviceId,
      heartbeatId: options.heartbeatId,
      domain: options.classification?.domain,
      category: options.classification?.category,
      actionTaken: "close-tab",
    },
  });
  return { caseId: safetyCase.id, decisionId: decision.id };
}

export default router;
