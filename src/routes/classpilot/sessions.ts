import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getActiveClassOwnersForStudents,
  getActiveSessionByStudent,
  getActiveSupervisionForStudents,
  getActiveTeachingSessionForSchool,
  getClasspilotSessionStudents,
  getTeachingSessionByIdAndSchool,
  getSessionSettings,
  getGroupByIdAndSchool,
  getScheduledTeachingSessionOccurrence,
  getGroupTeachers,
  getGroupStudents,
  resyncActiveClasspilotSessionStudents,
  getSchoolById,
  getUserById,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";
import { buildClassStartOverlapPayload } from "../../services/classpilotStartOverlap.js";
import {
  dispatchDueClasspilotSessionSummaries,
  finalizeClasspilotSession,
  startManualClasspilotSession,
  serializeClasspilotSession,
} from "../../services/classpilotSessionLifecycle.js";
import {
  emitClasspilotScheduleRuntimeMetric,
  processScheduledClassAutoStart,
} from "../../services/classpilotScheduledStart.js";
import { getEffectiveClasspilotScheduleWindow } from "../../services/classpilotScheduleChanges.js";
import { localDateTimeUtc } from "../../util/schoolTime.js";
import { updateAndFanoutSessionFabSettings } from "../../services/classpilotFab.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "office_staff", "teacher"),
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

export async function assertManualStartWindow(group: any, now = new Date()) {
  if (!(group as any).scheduleEnabled || !(group as any).blockStartTime || !(group as any).blockEndTime) return;

  const school = await getSchoolById(group.schoolId);
  const tz = school?.schoolTimezone || "America/New_York";
  const todayDate = now.toLocaleDateString("en-CA", { timeZone: tz });
  if ((group as any).scheduleSkippedDate === todayDate) {
    throw Object.assign(new Error("Today's scheduled class occurrence has already ended or was skipped."), { status: 409 });
  }
  let effectiveWindow: Awaited<ReturnType<typeof getEffectiveClasspilotScheduleWindow>>;
  try {
    effectiveWindow = await getEffectiveClasspilotScheduleWindow({
      schoolId: group.schoolId,
      group,
      scheduledDate: todayDate,
      timeZone: tz,
    });
  } catch (error) {
    if ((error as { code?: string }).code === "SCHEDULE_CHANGE_EXECUTION_INVALID") {
      emitClasspilotScheduleRuntimeMetric("ScheduleChangeExecutionInvalid", 1, now);
    }
    emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure", 1, now);
    throw error;
  }
  if (!effectiveWindow) {
    throw Object.assign(new Error("This class does not have a valid schedule window."), {
      status: 409,
      code: "SCHEDULE_WINDOW_UNAVAILABLE",
    });
  }
  if (effectiveWindow.source === "swap") {
    emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolved", 1, now);
  }
  const isOutsideWindow = now < effectiveWindow.scheduledStartAt
    || now >= effectiveWindow.scheduledEndAt;
  if (isOutsideWindow) {
    if (
      effectiveWindow.source === "swap"
      && group.blockStartTime
      && group.blockEndTime
      && now >= localDateTimeUtc(todayDate, group.blockStartTime, tz)
      && now < localDateTimeUtc(todayDate, group.blockEndTime, tz)
    ) {
      emitClasspilotScheduleRuntimeMetric("OriginalWindowStartDenied", 1, now);
    }
    throw Object.assign(new Error(`Class is scheduled for ${formatTime(effectiveWindow.blockStartTime)} - ${formatTime(effectiveWindow.blockEndTime)}. Cannot start outside the scheduled window.`), {
      status: 403,
      code: effectiveWindow.source === "swap" ? "SCHEDULE_CHANGE_WINDOW_REQUIRED" : "SCHEDULE_WINDOW_REQUIRED",
    });
  }
}

function kickSummaryDispatch(schoolId: string, teachingSessionId: string) {
  void runWithTenantContext({ schoolId }, () =>
    dispatchDueClasspilotSessionSummaries({ schoolId, teachingSessionId, limit: 2 })
  ).catch((error) => {
    // The durable scheduler outbox remains authoritative if the immediate kick
    // cannot run; never fail or duplicate an already committed End response.
    console.warn(`[SessionSummary] Immediate dispatch deferred for ${teachingSessionId}:`, error);
  });
}

async function assertCanManageTeachingSession(req: any, res: any, session: any): Promise<void> {
  const role = res.locals.membershipRole as string | undefined;
  const isAdmin = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
  if (isAdmin) return;
  if (await isAuthorizedClasspilotSessionStaff(
    res.locals.schoolId!, session.id, req.authUser!.id
  )) return;
  throw Object.assign(new Error("Class session not found"), { status: 404 });
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

  const school = await getSchoolById(schoolId);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const now = new Date();
  const scheduledDate = now.toLocaleDateString("en-CA", { timeZone });
  const occurrence = await getScheduledTeachingSessionOccurrence(schoolId, group.id, scheduledDate);
  const scheduledPath = !!occurrence || (group.scheduleEnabled && !!group.blockStartTime && !!group.blockEndTime);
  if (occurrence) {
    if (
      occurrence.scheduledState !== "active"
      || occurrence.endTime
      || !occurrence.scheduledStartAt
      || !occurrence.scheduledEndAt
      || now < occurrence.scheduledStartAt
      || now >= occurrence.scheduledEndAt
    ) {
      throw Object.assign(new Error("Today's scheduled class occurrence is not active."), { status: 409 });
    }
  } else {
    await assertManualStartWindow(group);
  }

  const role = res.locals.membershipRole as string | undefined;
  const admin = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
  const scheduledTeacherId = occurrence?.teacherId || group.teacherId;
  const coTeachers = await getGroupTeachers(group.id);
  const assignedToActor = scheduledPath
    ? scheduledTeacherId === teacherId
    : scheduledTeacherId === teacherId || coTeachers.some((teacher) => teacher.teacherId === teacherId);
  if (!admin && !assignedToActor) {
    return res.status(403).json({ error: "This class is not assigned to you" });
  }

  if (occurrence?.sessionMode === "live") {
    const result = await processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now,
    });
    if (result.status !== "started") {
      throw Object.assign(new Error("Today's scheduled class occurrence cannot be restarted."), { status: 409 });
    }
    return res.status(200).json({ session: serializeClasspilotSession(result.session) });
  }

  if (acknowledgeOverlap !== true) {
    const overlap = await buildClassStartOverlapPayload({ schoolId, teacherId, group });
    if (overlap) {
      return res.status(409).json({
        error: "Some students are already active in another class",
        ...overlap,
      });
    }
  }

  if (scheduledPath) {
    const result = await processScheduledClassAutoStart({
      group,
      scheduledDate,
      scheduledTeacherConnectedOverride: true,
      now,
    });
    if (result.status !== "started") {
      throw Object.assign(new Error("Today's scheduled class occurrence cannot be restarted."), { status: 409 });
    }
    return res.status(201).json({ session: serializeClasspilotSession(result.session) });
  }

  const manualStart = await startManualClasspilotSession({
    schoolId,
    teacherId,
    groupId,
  });
  if (manualStart.replacementFinalization) {
    if (manualStart.replacementFinalization.deliveryCount && manualStart.replacedSessionId) {
      kickSummaryDispatch(schoolId, manualStart.replacedSessionId);
    }
  }
  const session = manualStart.session;
  return res.status(201).json({ session: serializeClasspilotSession(session) });
}

// POST /api/classpilot/teaching-sessions/start - Alias for creating a session
router.post("/start", ...auth, async (req, res, next) => {
  try {
    return await startTeachingSessionWithOverlapGuard(req, res);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
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

    const finalizationReason = existing.scheduledDate ? "teacher_end" as const : "manual_end" as const;
    const result = await finalizeClasspilotSession({
      schoolId: res.locals.schoolId!,
      sessionId: existing.id,
      reason: finalizationReason,
    });
    if (!result) return res.status(404).json({ error: "No active session" });
    res.json({
      session: serializeClasspilotSession(result.session),
      summaryDisposition: result.summaryDisposition,
      finalizationReason: result.session.scheduledFinalizationReason || finalizationReason,
    });
    if (result.deliveryCount > 0) kickSummaryDispatch(res.locals.schoolId!, existing.id);
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions - Start a teaching session
router.post("/", ...auth, async (req, res, next) => {
  try {
    return await startTeachingSessionWithOverlapGuard(req, res);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
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

    const settings = await getSessionSettings(res.locals.schoolId!, session.id);
    return res.json({ session: serializeClasspilotSession(session), settings });
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
    await assertCanManageTeachingSession(req, res, session);

    const settings = await getSessionSettings(res.locals.schoolId!, session.id);
    return res.json({ session: serializeClasspilotSession(session), settings });
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
    if ((session as any).sessionMode && (session as any).sessionMode !== "live") {
      return res.status(403).json({ error: "This scheduled reporting block is not a live class session" });
    }
    if (session.scheduledDate) {
      return res.status(409).json({
        code: "SCHEDULED_ROSTER_SNAPSHOT_FROZEN",
        error: "A scheduled class roster is frozen when the occurrence starts and cannot be resynced mid-block.",
      });
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

    // Every accepted resync is one serialized ownership transition, including
    // newly added students. If End Class won the row-lock race, fail closed
    // without mutating the frozen roster.
    const reconciled = await resyncActiveClasspilotSessionStudents({
      schoolId,
      teachingSessionId: session.id,
    });
    if (!reconciled) {
      return res.status(404).json({ error: "Active class session not found" });
    }
    const syncSummary = reconciled.summary;
    const updatedSession = reconciled.session;
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
      session: serializeClasspilotSession(updatedSession),
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
    await assertCanManageTeachingSession(req, res, owned);
    const role = res.locals.membershipRole as string | undefined;
    const adminEnd = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
    const finalizationReason = owned.scheduledDate
      ? adminEnd && owned.teacherId !== req.authUser!.id ? "admin_end" as const : "teacher_end" as const
      : "manual_end" as const;
    const result = await finalizeClasspilotSession({
      schoolId: res.locals.schoolId!,
      sessionId,
      reason: finalizationReason,
    });
    if (!result) return res.status(404).json({ error: "Session not found" });
    if (result.deliveryCount > 0) kickSummaryDispatch(res.locals.schoolId!, sessionId);
    return res.json({
      session: serializeClasspilotSession(result.session),
      summaryDisposition: result.summaryDisposition,
      finalizationReason: result.session.scheduledFinalizationReason || finalizationReason,
    });
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
    await assertCanManageTeachingSession(req, res, owned);
    if (!(await isAuthorizedClasspilotSessionStaff(
      res.locals.schoolId!,
      sessionId,
      req.authUser!.id
    ))) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (owned.endTime || owned.sessionMode !== "live") {
      return res.status(409).json({
        error: "Settings can only be changed for an active live class session",
        code: "SESSION_NOT_LIVE",
      });
    }
    const { chatEnabled, raiseHandEnabled } = req.body;
    if (chatEnabled !== undefined && typeof chatEnabled !== "boolean") {
      return res.status(400).json({ error: "chatEnabled must be a boolean" });
    }
    if (raiseHandEnabled !== undefined && typeof raiseHandEnabled !== "boolean") {
      return res.status(400).json({ error: "raiseHandEnabled must be a boolean" });
    }
    if (chatEnabled === undefined && raiseHandEnabled === undefined) {
      return res.status(400).json({ error: "At least one session setting is required" });
    }
    const result = await updateAndFanoutSessionFabSettings({
      schoolId: res.locals.schoolId!,
      teachingSessionId: sessionId,
      actorId: req.authUser!.id,
      chatEnabled,
      raiseHandEnabled,
      expectedRevision: Number.isInteger(req.body?.expectedRevision) ? req.body.expectedRevision : undefined,
    });
    return res.json({
      settings: result.settings,
      state: result.state,
      targetedStudentCount: result.targetedStudentCount,
    });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.current ? { current: err.current } : {}),
    });
    next(err);
  }
});

export default router;
