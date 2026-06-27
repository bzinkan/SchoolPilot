import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  createTeachingSession,
  endTeachingSession,
  getActiveClassOwnersForStudents,
  getActiveSessionByStudent,
  getActiveSupervisionForStudents,
  getActiveTeachingSessionForSchool,
  getClasspilotSessionStudents,
  getTeachingSessionByIdAndSchool,
  getSessionSettings,
  upsertSessionSettings,
  getGroupById,
  getGroupByIdAndSchool,
  getGroupTeachers,
  getGroupStudents,
  getHeartbeatsForStudentsInRange,
  resyncClasspilotSessionStudents,
  setScheduleSkippedDate,
  getSchoolById,
  getCentralEmailRecipientForSchool,
  clearClasspilotClassroomStates,
  clearClasspilotActiveHandsForSession,
  getUserById,
  updateTeachingSessionControlTimestamp,
} from "../../services/storage.js";
import { sendSessionSummaryEmail } from "../../services/email.js";
import { logAudit } from "../../services/audit.js";
import db from "../../db.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

function displayName(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "Unknown teacher";
}

function studentName(student: any): string {
  return [student?.firstName, student?.lastName].filter(Boolean).join(" ").trim() || student?.email || student?.id || "Unknown student";
}

function formatTime(t: string) {
  const parts = t.split(":");
  const hour = parseInt(parts[0] || "0", 10);
  const m = parts[1] || "00";
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${m} ${ampm}`;
}

async function assertManualStartWindow(group: any) {
  if (!(group as any).scheduleEnabled || !(group as any).blockStartTime || !(group as any).blockEndTime) return;

  const school = await getSchoolById(group.schoolId);
  const tz = school?.schoolTimezone || "America/New_York";
  const now = new Date();
  const currentTimeHHMM = now.toLocaleString("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(/^24:/, "00:");
  const isOutsideWindow = currentTimeHHMM < (group as any).blockStartTime || currentTimeHHMM >= (group as any).blockEndTime;
  if (isOutsideWindow) {
    throw Object.assign(new Error(`Class is scheduled for ${formatTime((group as any).blockStartTime)} - ${formatTime((group as any).blockEndTime)}. Cannot start outside the scheduled window.`), { status: 403 });
  }
}

async function classStartOverlapPayload(options: {
  schoolId: string;
  teacherId: string;
  group: any;
}) {
  const rosterRows = await getGroupStudents(options.group.id);
  const studentIds = rosterRows.map((row) => row.studentId);
  if (studentIds.length === 0) return null;

  const owners = await getActiveClassOwnersForStudents(options.schoolId, studentIds);
  const conflicts = owners.filter((owner) => owner.session.teacherId !== options.teacherId);
  if (conflicts.length === 0) return null;

  const studentsById = new Map(rosterRows.map((row) => [row.studentId, row.student]));
  const bySession = new Map<string, {
    sessionId: string;
    classId: string;
    className: string;
    teacherId: string;
    teacherName: string;
    affectedCount: number;
    affectedStudents: Array<{ studentId: string; studentName: string }>;
  }>();
  const teacherIds = [...new Set(conflicts.map((owner) => owner.session.teacherId))];
  const teacherEntries = await Promise.all(teacherIds.map(async (id) => [id, await getUserById(id)] as const));
  const teachersById = new Map(teacherEntries);

  for (const owner of conflicts) {
    const row = bySession.get(owner.session.id) || {
      sessionId: owner.session.id,
      classId: owner.groupId,
      className: owner.groupName,
      teacherId: owner.session.teacherId,
      teacherName: displayName(teachersById.get(owner.session.teacherId)),
      affectedCount: 0,
      affectedStudents: [],
    };
    row.affectedCount += 1;
    if (row.affectedStudents.length < 5) {
      row.affectedStudents.push({
        studentId: owner.studentId,
        studentName: studentName(studentsById.get(owner.studentId)),
      });
    }
    bySession.set(owner.session.id, row);
  }

  const groups = Array.from(bySession.values()).sort((a, b) => b.affectedCount - a.affectedCount || a.className.localeCompare(b.className));
  const totalOverlapCount = groups.reduce((sum, group) => sum + group.affectedCount, 0);
  return {
    code: "CLASS_ROSTER_ACTIVE_OVERLAP",
    severity: "warning",
    requiresAcknowledgement: true,
    canStartAnyway: true,
    selectedClass: {
      id: options.group.id,
      name: options.group.name,
    },
    totalOverlapCount,
    groups,
  };
}

async function assertCanManageTeachingSession(req: any, res: any, session: any): Promise<void> {
  const role = res.locals.membershipRole as string | undefined;
  const isAdmin = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
  if (isAdmin || session.teacherId === req.authUser!.id) return;

  const coTeachers = await getGroupTeachers(session.groupId);
  if (coTeachers.some((teacher) => teacher.teacherId === req.authUser!.id)) return;

  throw Object.assign(new Error("This class session is not assigned to you"), { status: 403 });
}

function emptyResyncSummary() {
  return {
    rosterCount: 0,
    alreadyInSession: 0,
    addedToSession: 0,
    online: 0,
    notSignedIn: 0,
    claimedByCoverage: 0,
    activeElsewhere: 0,
    requiresAcknowledgement: false,
    conflicts: [] as Array<{
      sessionId: string;
      classId: string;
      className: string;
      teacherId: string;
      teacherName: string;
      affectedCount: number;
      affectedStudents: Array<{ studentId: string; studentName: string }>;
    }>,
  };
}

async function classResyncPreview(options: {
  schoolId: string;
  session: any;
  group: any;
}) {
  const rosterRows = await getGroupStudents(options.group.id);
  const rosterStudentIds = rosterRows.map((row) => row.studentId);
  if (rosterStudentIds.length === 0) return emptyResyncSummary();

  const [sessionRows, owners, supervision] = await Promise.all([
    getClasspilotSessionStudents(options.session.id),
    getActiveClassOwnersForStudents(options.schoolId, rosterStudentIds),
    getActiveSupervisionForStudents(options.schoolId, rosterStudentIds),
  ]);
  const sessionStudentIds = new Set(sessionRows.map((row) => row.studentId));
  const activeSupervisionByStudent = new Map(supervision.map((entry) => [entry.studentId, entry.context]));
  const ownerConflicts = owners.filter((owner) => owner.session.id !== options.session.id);
  const ownerConflictsByStudent = new Map(ownerConflicts.map((owner) => [owner.studentId, owner]));
  const studentsById = new Map(rosterRows.map((row) => [row.studentId, row.student]));
  const teacherIds = [...new Set(ownerConflicts.map((owner) => owner.session.teacherId))];
  const teacherEntries = await Promise.all(teacherIds.map(async (id) => [id, await getUserById(id)] as const));
  const teachersById = new Map(teacherEntries);
  const bySession = new Map<string, {
    sessionId: string;
    classId: string;
    className: string;
    teacherId: string;
    teacherName: string;
    affectedCount: number;
    affectedStudents: Array<{ studentId: string; studentName: string }>;
  }>();

  let online = 0;
  for (const row of rosterRows) {
    const active = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = active?.lastSeenAt?.getTime?.() || 0;
    if (active && lastSeenAt > 0 && Date.now() - lastSeenAt <= 5 * 60 * 1000) {
      online++;
    }

    const owner = ownerConflictsByStudent.get(row.studentId);
    if (!owner) continue;
    const conflict = bySession.get(owner.session.id) || {
      sessionId: owner.session.id,
      classId: owner.groupId,
      className: owner.groupName,
      teacherId: owner.session.teacherId,
      teacherName: displayName(teachersById.get(owner.session.teacherId)),
      affectedCount: 0,
      affectedStudents: [],
    };
    conflict.affectedCount += 1;
    if (conflict.affectedStudents.length < 5) {
      conflict.affectedStudents.push({
        studentId: owner.studentId,
        studentName: studentName(studentsById.get(owner.studentId)),
      });
    }
    bySession.set(owner.session.id, conflict);
  }

  const conflicts = Array.from(bySession.values()).sort((a, b) => b.affectedCount - a.affectedCount || a.className.localeCompare(b.className));
  const activeElsewhere = conflicts.reduce((total, conflict) => total + conflict.affectedCount, 0);
  return {
    rosterCount: rosterRows.length,
    alreadyInSession: rosterRows.filter((row) => sessionStudentIds.has(row.studentId)).length,
    addedToSession: 0,
    online,
    notSignedIn: rosterRows.length - online,
    claimedByCoverage: rosterRows.filter((row) => activeSupervisionByStudent.has(row.studentId)).length,
    activeElsewhere,
    requiresAcknowledgement: activeElsewhere > 0,
    conflicts,
  };
}

function classResyncAuditSummary(summary: ReturnType<typeof emptyResyncSummary>) {
  return {
    rosterCount: summary.rosterCount,
    alreadyInSession: summary.alreadyInSession,
    addedToSession: summary.addedToSession,
    online: summary.online,
    notSignedIn: summary.notSignedIn,
    claimedByCoverage: summary.claimedByCoverage,
    activeElsewhere: summary.activeElsewhere,
    requiresAcknowledgement: summary.requiresAcknowledgement,
  };
}

async function startTeachingSessionWithOverlapGuard(req: any, res: any) {
  const { groupId, acknowledgeOverlap } = req.body;
  const teacherId = req.authUser!.id;
  const schoolId = res.locals.schoolId!;

  if (!groupId) {
    return res.status(400).json({ error: "groupId is required" });
  }

  const group = await getGroupByIdAndSchool(groupId, schoolId);
  if (!group) {
    return res.status(404).json({ error: "Group not found" });
  }

  await assertManualStartWindow(group);

  if (acknowledgeOverlap !== true) {
    const overlap = await classStartOverlapPayload({ schoolId, teacherId, group });
    if (overlap) {
      return res.status(409).json({
        error: "Some students are already active in another class",
        ...overlap,
      });
    }
  }

  const existing = await getActiveTeachingSessionForSchool(teacherId, schoolId);
  if (existing) {
    await endTeachingSession(existing.id);
    await clearClasspilotClassroomStates({ schoolId, teachingSessionId: existing.id });
    await clearClasspilotActiveHandsForSession(schoolId, existing.id);
  }

  const session = await createTeachingSession({ groupId, teacherId });
  return res.status(201).json({ session });
}

// POST /api/classpilot/teaching-sessions/start - Alias for creating a session
router.post("/start", ...auth, async (req, res, next) => {
  try {
    return await startTeachingSessionWithOverlapGuard(req, res);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions/end - End the active session
router.post("/end", ...auth, async (req, res, next) => {
  try {
    const existing = await getActiveTeachingSessionForSchool(req.authUser!.id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "No active session" });
    }

    // getActiveTeachingSession is keyed by teacherId only, so a multi-school
    // teacher's stale active session could belong to a DIFFERENT school. Only
    // end / summarize (which emails the roster) a session whose group is in the
    // current school context — otherwise treat as no active session here.
    const group = await getGroupByIdAndSchool(existing.groupId, res.locals.schoolId!);
    if (!group) {
      return res.status(404).json({ error: "No active session" });
    }

    const session = await endTeachingSession(existing.id);
    await clearClasspilotClassroomStates({ schoolId: res.locals.schoolId!, teachingSessionId: existing.id });
    await clearClasspilotActiveHandsForSession(res.locals.schoolId!, existing.id);
    res.json({ session });

    // If this was a scheduled class and we're PAST the scheduled end time,
    // mark as skipped so the scheduler doesn't restart it today.
    // If ended DURING the window, don't skip — teacher might restart (accidental end).
    if ((group as any).scheduleEnabled && (group as any).blockEndTime) {
      try {
        const school = await getSchoolById(group.schoolId);
        const tz = school?.schoolTimezone || "America/New_York";
        const now = new Date();
        const currentTimeHHMM = now.toLocaleString("en-US", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
        }).replace(/^24:/, "00:");
        // Only skip if we're past the scheduled end time (class ran its full window)
        if (currentTimeHHMM >= (group as any).blockEndTime) {
          const todayDate = now.toLocaleDateString("en-CA", { timeZone: tz });
          await setScheduleSkippedDate(group.id, todayDate);
        }
      } catch (err) {
        console.warn("[Sessions] Failed to set scheduleSkippedDate:", err);
      }
    }

    // Fire-and-forget: send session summary email to teacher. This runs AFTER
    // res.json above, so the request's tenant connection is already released —
    // re-establish the school's context for the students/heartbeats reads inside
    // the summary (otherwise RLS deny-by-default empties them).
    if (session?.startTime && session?.endTime) {
      const summarySchoolId = res.locals.schoolId!;
      void runWithTenantContext({ schoolId: summarySchoolId }, () =>
        buildAndSendSessionSummary(session, req.authUser!)
      ).catch((err) => console.error("[SessionSummary] Failed to send:", err));
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions - Start a teaching session
router.post("/", ...auth, async (req, res, next) => {
  try {
    return await startTeachingSessionWithOverlapGuard(req, res);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/classpilot/teaching-sessions/active - Get current active session
router.get("/active", ...auth, async (req, res, next) => {
  try {
    const session = await getActiveTeachingSessionForSchool(req.authUser!.id, res.locals.schoolId!);
    if (!session) {
      return res.json({ session: null });
    }

    // getActiveTeachingSession is keyed by teacherId only — for a multi-school
    // teacher this could be a session in a different school. Only surface a
    // session whose group is in the current school context.
    const group = await getGroupByIdAndSchool(session.groupId, res.locals.schoolId!);
    if (!group) {
      return res.json({ session: null });
    }

    const settings = await getSessionSettings(session.id);
    return res.json({ session, settings });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/teaching-sessions/:id - Get session by ID
router.get("/:id", ...auth, async (req, res, next) => {
  try {
    const session = await getTeachingSessionByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const settings = await getSessionSettings(session.id);
    return res.json({ session, settings });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions/:id/resync - Reconcile active session roster
router.post("/:id/resync", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const session = await getTeachingSessionByIdAndSchool(sessionId, schoolId);
    if (!session || session.endTime) {
      return res.status(404).json({ error: "Active class session not found" });
    }

    const group = await getGroupByIdAndSchool(session.groupId, schoolId);
    if (!group) {
      return res.status(404).json({ error: "Active class group not found" });
    }

    await assertCanManageTeachingSession(req, res, session);

    const preview = await classResyncPreview({ schoolId, session, group });
    const acknowledgeOverlap = req.body?.acknowledgeOverlap === true;
    if (preview.activeElsewhere > 0 && !acknowledgeOverlap) {
      await logAudit({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
        action: "classpilot.session.resync",
        entityType: "teaching_session",
        entityId: session.id,
        entityName: group.name,
        changes: {
          acknowledgedOverlap: false,
          summary: classResyncAuditSummary(preview),
        },
        metadata: {
          conflictSessionIds: preview.conflicts.map((conflict) => conflict.sessionId),
        },
      });
      return res.status(409).json({
        error: "Some students are already active in another class",
        code: "CLASS_RESYNC_ACTIVE_OVERLAP",
        severity: "warning",
        canResyncAnyway: true,
        ...preview,
      });
    }

    const syncSummary = await resyncClasspilotSessionStudents(session);
    const updatedSession = acknowledgeOverlap && preview.activeElsewhere > 0
      ? await updateTeachingSessionControlTimestamp(session.id)
      : session;
    const summary = {
      ...preview,
      rosterCount: syncSummary.rosterCount,
      alreadyInSession: syncSummary.alreadyInSession,
      addedToSession: syncSummary.addedToSession,
      requiresAcknowledgement: false,
    };

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "classpilot.session.resync",
      entityType: "teaching_session",
      entityId: session.id,
      entityName: group.name,
      changes: {
        acknowledgedOverlap: acknowledgeOverlap,
        summary: classResyncAuditSummary(summary),
      },
      metadata: {
        conflictSessionIds: preview.conflicts.map((conflict) => conflict.sessionId),
      },
    });

    return res.json({
      session: updatedSession || session,
      ...summary,
    });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions/:id/end - End a teaching session
router.post("/:id/end", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const owned = await getTeachingSessionByIdAndSchool(sessionId, res.locals.schoolId!);
    if (!owned) {
      return res.status(404).json({ error: "Session not found" });
    }
    const session = await endTeachingSession(sessionId);
    await clearClasspilotClassroomStates({ schoolId: res.locals.schoolId!, teachingSessionId: sessionId });
    await clearClasspilotActiveHandsForSession(res.locals.schoolId!, sessionId);
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpilot/teaching-sessions/:id/settings - Update session settings
router.put("/:id/settings", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const owned = await getTeachingSessionByIdAndSchool(sessionId, res.locals.schoolId!);
    if (!owned) {
      return res.status(404).json({ error: "Session not found" });
    }
    const { chatEnabled, raiseHandEnabled } = req.body;

    const data: Record<string, unknown> = {};
    if (chatEnabled !== undefined) data.chatEnabled = chatEnabled;
    if (raiseHandEnabled !== undefined) data.raiseHandEnabled = raiseHandEnabled;

    const settings = await upsertSessionSettings(sessionId, data);
    return res.json({ settings });
  } catch (err) {
    next(err);
  }
});

// Build and send session summary email (called async after response, or by scheduler)
export async function buildAndSendSessionSummary(
  session: { id: string; groupId: string; startTime: Date; endTime: Date | null },
  teacher: { email: string; firstName?: string; lastName?: string },
  dbInstance: typeof db = db
) {
  const endTime = session.endTime ?? new Date();
  // Threads dbInstance through every tenant-table read so the scheduler's
  // fire-and-forget callers (which run outside any request tenant context) can
  // pass schedulerDb (app.is_super) and not hit RLS deny-by-default on the
  // groups/students/heartbeats reads. Request callers use the default GUC db.
  const group = await getGroupById(session.groupId, dbInstance);
  const className = (group as any)?.name || "Class";

  // Use school timezone for formatting (instead of hardcoded America/New_York).
  // schools is a global (non-RLS) table, so it needs no dbInstance override.
  const school = await getSchoolById(group?.schoolId || "");
  const tz = school?.schoolTimezone || "America/New_York";

  const groupStudentRows = await getGroupStudents(session.groupId, dbInstance);
  const studentIds = groupStudentRows.map((gs) => gs.studentId);

  const hbs = await getHeartbeatsForStudentsInRange(studentIds, session.startTime, endTime, dbInstance);

  // Build per-student domain summaries
  const studentMap = new Map<string, { name: string; domainSeconds: Map<string, number>; count: number; offTaskCount: number; safetyAlerts: string[]; safetyUrls: string[] }>();
  for (const gs of groupStudentRows) {
    const name = [gs.student.firstName, gs.student.lastName].filter(Boolean).join(" ") || gs.student.email || "Unknown";
    studentMap.set(gs.studentId, { name, domainSeconds: new Map(), count: 0, offTaskCount: 0, safetyAlerts: [], safetyUrls: [] });
  }

  for (const hb of hbs) {
    if (!hb.studentId) continue;
    const entry = studentMap.get(hb.studentId);
    if (!entry) continue;
    entry.count++;
    if ((hb as any).aiCategory === "non-educational") entry.offTaskCount++;
    if ((hb as any).safetyAlert) {
      entry.safetyAlerts.push((hb as any).safetyAlert);
      if (hb.activeTabUrl) {
        try { entry.safetyUrls.push(new URL(hb.activeTabUrl).hostname.replace(/^www\./, "")); } catch {}
      }
    }
    if (hb.activeTabUrl) {
      try {
        const domain = new URL(hb.activeTabUrl).hostname.replace(/^www\./, "");
        entry.domainSeconds.set(domain, (entry.domainSeconds.get(domain) || 0) + 10);
      } catch { /* skip invalid URLs */ }
    }
  }

  const students = Array.from(studentMap.values()).map((s) => {
    const topDomains = Array.from(s.domainSeconds.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([domain, seconds]) => ({ domain, minutes: Math.round(seconds / 60) }));
    const uniqueSafetyAlerts = [...new Set(s.safetyAlerts)];
    const uniqueSafetyUrls = [...new Set(s.safetyUrls)];
    return { name: s.name, totalMinutes: Math.round((s.count * 10) / 60), topDomains, offTaskCount: s.offTaskCount, safetyAlerts: uniqueSafetyAlerts, safetyUrls: uniqueSafetyUrls };
  });

  const durationMs = endTime.getTime() - session.startTime.getTime();
  const durationMin = Math.round(durationMs / 60000);
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const teacherName = [teacher.firstName, teacher.lastName].filter(Boolean).join(" ") || "Teacher";

  await sendSessionSummaryEmail({
    to: teacher.email,
    teacherName,
    className,
    date: fmtDate(session.startTime),
    startTime: fmt(session.startTime),
    endTime: fmt(endTime),
    duration: `${durationMin} min`,
    studentCount: studentIds.length,
    students,
  });

  console.log(`[SessionSummary] Sent to ${teacher.email} for "${className}"`);

  const centralRecipient = group?.schoolId
    ? await getCentralEmailRecipientForSchool(group.schoolId, dbInstance)
    : undefined;
  const centralEmail = centralRecipient?.email?.trim();
  if (centralEmail && centralEmail.toLowerCase() !== teacher.email.trim().toLowerCase()) {
    await sendSessionSummaryEmail({
      to: centralEmail,
      teacherName,
      className,
      date: fmtDate(session.startTime),
      startTime: fmt(session.startTime),
      endTime: fmt(endTime),
      duration: `${durationMin} min`,
      studentCount: studentIds.length,
      students,
      copyNotice: `Central school copy of the session summary sent to ${teacher.email}.`,
    });
    console.log(`[SessionSummary] Central copy sent to ${centralEmail} for "${className}"`);
  }
}

export default router;
