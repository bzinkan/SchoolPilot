import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getSchoolById,
  getSessionById,
  getSessionBySchoolAndDate,
  getOrCreateSession,
  updateSessionStatus,
  getQueueBySession,
  getMaxQueuePosition,
  isStudentInQueue,
  addToQueue,
  updateQueueEntry,
  callQueueEntry,
  callNextBatch,
  releaseQueueEntry,
  dismissQueueEntry,
  batchDismiss,
  batchRelease,
  holdQueueEntry,
  delayQueueEntry,
  getSessionStats,
  getActivityLog,
  getStudentById,
  getUserById,
  getHomeroomById,
  getCarRiderChildrenForParent,
  getStudentsByBusRoute,
  getStudentsByDismissalType,
  getFamilyGroupByCarNumber,
  getFamilyGroupStudents,
  getAbsentStudentIds,
  upsertDismissalOverride,
  deleteDismissalOverride,
  getOverridesForSession,
  getOverrideForStudent,
  getEffectiveDismissalType,
  getEffectiveDismissalTypes,
  getStudentsByHomeroomId,
  getParentStudents,
  getHomeroomTeachers,
  getActiveCustodyAlertsForStudent,
  createStudentTimelineEvent,
} from "../../services/storage.js";
import {
  canAccessStudent,
  getApprovedParentStudentIds,
  getQueueEntryForSchool,
  getRequestGoPilotRole,
  getSessionForSchool,
  getTeacherHomeroomIds,
  isGoPilotManager,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
import { getIO } from "../../realtime/socketio.js";
import { db } from "../../db.js";
import { dismissalSessions, dismissalQueue, parentStudent } from "../../schema/gopilot.js";
import { eq, and } from "drizzle-orm";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

const staffAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const managerAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff"),
] as const;

function emitToSchool(schoolId: string, room: string, event: string, data: unknown) {
  const io = getIO();
  if (io) io.to(`school:${schoolId}:${room}`).emit(event, data);
}

type CheckInStudentSummary = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  homeroomId?: string | null;
};

function studentName(student: CheckInStudentSummary): string {
  return `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.id;
}

function checkInOutcome(
  createdCount: number,
  duplicateCount: number,
  skippedAbsentCount: number
): "created" | "duplicate" | "partial" {
  if (createdCount === 0 && duplicateCount > 0 && skippedAbsentCount === 0) return "duplicate";
  if (duplicateCount > 0 || skippedAbsentCount > 0) return "partial";
  return "created";
}

function buildCheckInResponse(options: {
  groupLabel: string;
  entries: Array<{ entry: any; student: CheckInStudentSummary }>;
  duplicateCount: number;
  skippedDuplicate?: CheckInStudentSummary[];
  skippedAbsent: CheckInStudentSummary[];
}) {
  const skippedDuplicate = options.skippedDuplicate ?? [];
  const duplicateCount = skippedDuplicate.length || options.duplicateCount;
  return {
    outcome: checkInOutcome(options.entries.length, duplicateCount, options.skippedAbsent.length),
    groupLabel: options.groupLabel,
    entries: options.entries.map(({ entry, student }) => ({
      queueId: entry.id,
      studentId: entry.studentId,
      studentName: studentName(student),
      status: entry.status,
      pickupGroupId: entry.pickupGroupId ?? null,
      pickupGroupLabel: entry.pickupGroupLabel ?? entry.guardianName ?? options.groupLabel,
    })),
    skippedAbsent: options.skippedAbsent.map((student) => ({
      studentId: student.id,
      studentName: studentName(student),
    })),
    skippedDuplicate: skippedDuplicate.map((student) => ({
      studentId: student.id,
      studentName: studentName(student),
    })),
  };
}

async function getSchoolLocalDate(schoolId: string): Promise<string> {
  const school = await getSchoolById(schoolId);
  const timeZone = school?.schoolTimezone ?? "America/New_York";
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

function rejectInactiveSession(res: any, session: { status?: string } | null | undefined): boolean {
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return true;
  }
  if (session.status !== "active") {
    res.status(409).json({
      error: "Dismissal session must be active for this action",
      sessionStatus: session.status,
    });
    return true;
  }
  return false;
}

function serializeCustodyAlerts(alerts: Array<any>) {
  return alerts.map((alert) => ({
    id: alert.id,
    studentId: alert.studentId,
    studentFirstName: alert.studentFirstName ?? null,
    studentLastName: alert.studentLastName ?? null,
    studentName: `${alert.studentFirstName || ""} ${alert.studentLastName || ""}`.trim(),
    personName: alert.personName,
    alertType: alert.alertType,
    notes: alert.notes ?? null,
    courtOrder: alert.courtOrder ?? null,
  }));
}

type WalkerFilter = { filterType?: "grade" | "homeroom"; filterValues?: string[] };

function matchesWalkerFilter(student: any, filter?: WalkerFilter): boolean {
  if (!filter?.filterType || !filter.filterValues?.length) return true;
  if (filter.filterType === "grade") {
    return filter.filterValues.includes(String(student.gradeLevel ?? student.grade ?? ""));
  }
  return filter.filterValues.includes(String(student.homeroomId ?? ""));
}

async function getEffectiveWalkerStudents(
  schoolId: string,
  sessionId: string,
  filter?: WalkerFilter
) {
  const permanentWalkers = filter?.filterType && filter.filterValues?.length
    ? (await Promise.all(filter.filterValues.map((value) =>
        getStudentsByDismissalType(
          schoolId,
          "walker",
          filter.filterType === "grade" ? { grade: value } : { homeroomId: value }
        )
      ))).flat()
    : await getStudentsByDismissalType(schoolId, "walker");

  const allOverrides = await getOverridesForSession(sessionId);
  const studentById = new Map(permanentWalkers.map((student) => [student.id, student]));
  const walkerIds = new Set(permanentWalkers.map((student) => student.id));

  for (const override of allOverrides) {
    if (override.overrideType !== "walker") {
      walkerIds.delete(override.studentId);
      continue;
    }
    let student = studentById.get(override.studentId);
    if (!student) {
      const fetched = await getStudentById(override.studentId);
      if (fetched && fetched.schoolId === schoolId && fetched.status === "active") {
        student = fetched;
        studentById.set(fetched.id, fetched);
      }
    }
    if (student && matchesWalkerFilter(student, filter)) {
      walkerIds.add(override.studentId);
    }
  }

  return [...walkerIds]
    .map((id) => studentById.get(id))
    .filter((student): student is NonNullable<typeof student> => !!student && matchesWalkerFilter(student, filter));
}

async function releaseWalkerStudents(options: {
  schoolId: string;
  sessionId: string;
  actorUserId: string;
  filter?: WalkerFilter;
}) {
  const walkers = await getEffectiveWalkerStudents(options.schoolId, options.sessionId, options.filter);
  const today = await getSchoolLocalDate(options.schoolId);
  const absentIds = await getAbsentStudentIds(options.schoolId, today);
  const skippedAbsent = walkers.filter((student) => absentIds.has(student.id));
  const presentWalkers = walkers.filter((student) => !absentIds.has(student.id));
  const skippedDuplicate: CheckInStudentSummary[] = [];
  const entries: Array<{ entry: any; student: CheckInStudentSummary }> = [];
  let position = await getMaxQueuePosition(options.sessionId);
  const pickupGroupId = options.filter?.filterType && options.filter.filterValues?.length
    ? `walkers:${options.filter.filterType}:${[...options.filter.filterValues].sort().join(",")}`
    : "walkers:all";

  for (const student of presentWalkers) {
    const alreadyInQueue = await isStudentInQueue(options.sessionId, student.id);
    if (alreadyInQueue) {
      skippedDuplicate.push(student);
      continue;
    }

    position++;
    const entry = await addToQueue({
      sessionId: options.sessionId,
      studentId: student.id,
      guardianName: "Walkers",
      pickupGroupId,
      pickupGroupLabel: "Walkers",
      checkInMethod: "walker",
      status: "dismissed",
      dismissedAt: new Date(),
      position,
    });
    entries.push({ entry, student });
    await recordDismissalTimeline({
      schoolId: options.schoolId,
      entry,
      action: "walker released",
      actorUserId: options.actorUserId,
      metadata: options.filter,
    });

    if (student.homeroomId) {
      emitToSchool(options.schoolId, `teacher:${student.homeroomId}`, "student:dismissed", { entry });
    }
  }

  emitToSchool(options.schoolId, "office", "queue:updated", {
    action: "walkers_released",
    entries: entries.map(({ entry }) => entry),
  });

  return buildCheckInResponse({
    groupLabel: "Walkers",
    entries,
    duplicateCount: skippedDuplicate.length,
    skippedDuplicate,
    skippedAbsent,
  });
}

async function recordDismissalTimeline(options: {
  schoolId: string;
  entry?: any;
  studentId?: string;
  sourceId?: string;
  action: string;
  actorUserId?: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const studentId = options.studentId || options.entry?.studentId;
  if (!studentId) return;
  await createStudentTimelineEvent({
    schoolId: options.schoolId,
    studentId,
    eventType: "dismissal",
    sourceType: "gopilot",
    sourceId: options.sourceId || options.entry?.id || null,
    title: `Dismissal ${options.action}`,
    summary: options.summary || options.entry?.guardianName || options.entry?.checkInMethod || null,
    actorUserId: options.actorUserId || null,
    metadata: {
      status: options.entry?.status,
      checkInMethod: options.entry?.checkInMethod,
      sessionId: options.entry?.sessionId,
      guardianName: options.entry?.guardianName,
      ...options.metadata,
    },
  });
}

// ============================================================================
// Session Management
// ============================================================================

// POST /api/gopilot/dismissal/sessions - Create or get today's session
router.post("/sessions", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const localDate = await getSchoolLocalDate(schoolId);

    const session = await getOrCreateSession(schoolId, localDate);
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/today - Read today's session without creating/resetting
router.get("/sessions/today", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const localDate = await getSchoolLocalDate(schoolId);
    const session = await getSessionBySchoolAndDate(schoolId, localDate);
    return res.json({ session: session ?? null });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/active - Get today's active session (if any)
router.get("/sessions/active", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const localDate = await getSchoolLocalDate(schoolId);

    // Only return session if it is actually active (not pending/completed)
    const [session] = await db
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.schoolId, schoolId),
          eq(dismissalSessions.date, localDate),
          eq(dismissalSessions.status, "active")
        )
      )
      .limit(1);

    return res.json(session ? { session } : null);
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id
router.get("/sessions/:id", ...auth, async (req, res, next) => {
  try {
    const session = await getSessionForSchool(param(req, "id"), res.locals.schoolId!);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/dismissal/sessions/:id - Update session status (start/pause/complete)
router.put("/sessions/:id", ...managerAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { status } = req.body;
    if (!["pending", "active", "paused", "completed"].includes(status)) {
      return res.status(400).json({ error: "Invalid session status" });
    }

    const schoolId = res.locals.schoolId!;
    const existing = await getSessionForSchool(id, schoolId);
    if (!existing) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (existing.status === "completed" && status !== "completed") {
      return res.status(409).json({ error: "Completed dismissal sessions cannot be restarted" });
    }
    if (status === "completed") {
      const stats = await getSessionStats(id);
      const outstanding = (stats?.total ?? 0) - (stats?.dismissed ?? 0);
      if (outstanding > 0) {
        return res.status(409).json({
          error: "Dismissal cannot be completed while students are still outstanding",
          outstanding,
          counts: stats,
        });
      }
    }
    const session = await updateSessionStatus(id, status);

    // Notify all connected clients in this school's room
    const io = getIO();
    if (io) {
      io.to(`school:${schoolId}`).emit("dismissal:status", { session });
    }
    if (io && status === "active") {
      io.to(`school:${schoolId}`).emit("dismissal:started", { sessionId: id, session });
    } else if (io && status === "completed") {
      io.to(`school:${schoolId}`).emit("dismissal:ended", { sessionId: id, session });
    }

    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Queue
// ============================================================================

// GET /api/gopilot/dismissal/sessions/:id/queue
router.get("/sessions/:id/queue", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(sessionId, schoolId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const filterStatus = (req.query.status as string) || undefined;

    const entries = await getQueueBySession(sessionId, filterStatus);
    const role = await getRequestGoPilotRole(req, res);
    const parentStudentIds = role === "parent"
      ? await getApprovedParentStudentIds(req.authUser!.id, schoolId)
      : null;
    const teacherHomeroomIds = role === "teacher"
      ? await getTeacherHomeroomIds(req.authUser!.id, schoolId)
      : null;

    const studentIds = entries.map((e) => e.studentId);
    const overrides = await getOverridesForSession(sessionId);
    const overrideMap = new Map(overrides.map((override) => [override.studentId, override]));

    // Enrich each entry with student and homeroom data (snake_case for frontend compat)
    const queue = await Promise.all(
      entries.map(async (entry) => {
        const student = await getStudentById(entry.studentId);
        if (!student || student.schoolId !== schoolId) return null;
        if (role === "parent" && !parentStudentIds?.has(entry.studentId)) return null;
        if (role === "teacher" && (!student.homeroomId || !teacherHomeroomIds?.has(student.homeroomId))) return null;
        if (!isGoPilotManager(role) && role !== "parent" && role !== "teacher") return null;
        let homeroomName: string | null = null;
        if (student?.homeroomId) {
          const homeroom = await getHomeroomById(student.homeroomId);
          homeroomName = homeroom?.name ?? null;
        }
        const override = overrideMap.get(entry.studentId);
        const permanentDismissalType = student?.dismissalType ?? null;
        const permanentBusRoute = student?.busRoute ?? null;
        const effectiveType = override?.overrideType ?? permanentDismissalType;
        const effectiveBusRoute = override?.busRoute ?? permanentBusRoute;
        return {
          id: entry.id,
          queueId: entry.id,
          session_id: entry.sessionId,
          sessionId: entry.sessionId,
          student_id: entry.studentId,
          studentId: entry.studentId,
          guardian_id: entry.guardianId,
          guardianId: entry.guardianId,
          guardian_name: entry.guardianName,
          guardianName: entry.guardianName,
          pickup_group_id: entry.pickupGroupId,
          pickupGroupId: entry.pickupGroupId,
          pickup_group_label: entry.pickupGroupLabel,
          pickupGroupLabel: entry.pickupGroupLabel,
          check_in_time: entry.checkInTime,
          checkInTime: entry.checkInTime,
          check_in_method: entry.checkInMethod,
          checkInMethod: entry.checkInMethod,
          status: entry.status,
          zone: entry.zone,
          called_at: entry.calledAt,
          calledAt: entry.calledAt,
          released_at: entry.releasedAt,
          releasedAt: entry.releasedAt,
          dismissed_at: entry.dismissedAt,
          dismissedAt: entry.dismissedAt,
          hold_reason: entry.holdReason,
          holdReason: entry.holdReason,
          delayed_until: entry.delayedUntil,
          delayedUntil: entry.delayedUntil,
          position: entry.position,
          created_at: entry.createdAt,
          createdAt: entry.createdAt,
          first_name: student?.firstName ?? null,
          firstName: student?.firstName ?? null,
          last_name: student?.lastName ?? null,
          lastName: student?.lastName ?? null,
          studentName: student ? `${student.firstName} ${student.lastName}` : null,
          grade: student?.gradeLevel ?? null,
          homeroom_name: homeroomName,
          homeroomName,
          dismissal_type: effectiveType,
          effectiveDismissalType: effectiveType,
          permanent_dismissal_type: permanentDismissalType,
          permanentDismissalType,
          is_overridden: !!override,
          isOverridden: !!override,
          bus_route: effectiveBusRoute,
          busRoute: effectiveBusRoute,
          permanentBusRoute,
          effectiveBusRoute,
          overrideReason: override?.reason ?? null,
        };
      })
    );

    return res.json(queue.filter(Boolean));
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Check-In Methods
// ============================================================================

// POST /api/gopilot/dismissal/sessions/:id/check-in - Parent app check-in
router.post("/sessions/:id/check-in", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const userId = req.authUser!.id;

    const session = await getSessionById(sessionId);
    if (!session || session.schoolId !== schoolId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (rejectInactiveSession(res, session)) return;

    // Get parent's car-rider children (permanent type + overrides for today)
    const permanentCarRiders = await getCarRiderChildrenForParent(userId, schoolId);

    // Also include children with car override for this session
    const parentLinks = await getParentStudents(userId);
    const allLinkedStudentIds = parentLinks
      .filter((l) => l.status === "approved")
      .map((l) => l.studentId);
    const effectiveTypes = allLinkedStudentIds.length > 0
      ? await getEffectiveDismissalTypes(allLinkedStudentIds, sessionId)
      : new Map<string, string>();

    // Merge: permanent car riders + overridden-to-car students (minus afterschool overrides)
    const carRiderIds = new Set(permanentCarRiders.map((s) => s.id));
    for (const [sid, etype] of effectiveTypes) {
      if (etype === "car") carRiderIds.add(sid);
      else carRiderIds.delete(sid); // e.g., permanent car rider overridden to bus
    }

    const carRiders: typeof permanentCarRiders = [];
    for (const sid of carRiderIds) {
      const existing = permanentCarRiders.find((s) => s.id === sid);
      if (existing) {
        carRiders.push(existing);
      } else {
        const student = await getStudentById(sid);
        if (student && student.schoolId === schoolId && student.status === "active") {
          carRiders.push(student);
        }
      }
    }

    if (carRiders.length === 0) {
      return res.status(400).json({ error: "No car-rider children found" });
    }

    const guardian = await getUserById(userId);
    const guardianName = guardian
      ? `${guardian.firstName} ${guardian.lastName}`
      : "Unknown";

    // Filter out absent students
    const today = await getSchoolLocalDate(schoolId);
    const absentIds = await getAbsentStudentIds(schoolId, today);
    const skippedAbsent: CheckInStudentSummary[] = [];
    const skippedDuplicate: CheckInStudentSummary[] = [];

    let position = await getMaxQueuePosition(sessionId);
    const entries: Array<{ entry: any; student: CheckInStudentSummary }> = [];

    for (const student of carRiders) {
      if (absentIds.has(student.id)) {
        skippedAbsent.push(student);
        continue;
      }
      const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
      if (alreadyInQueue) {
        skippedDuplicate.push(student);
        continue;
      }

      position++;
      const entry = await addToQueue({
        sessionId,
        studentId: student.id,
        guardianId: userId,
        guardianName,
        pickupGroupId: `parent:${userId}`,
        pickupGroupLabel: guardianName,
        checkInMethod: "app",
        position,
      });
      entries.push({ entry, student });
      await recordDismissalTimeline({ schoolId, entry, action: "checked in", actorUserId: userId });

      // Notify teacher homeroom
      if (student.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:checked-in", entry);
      }
    }

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "check_in",
      entries: entries.map(({ entry }) => entry),
    });

    return res.json(buildCheckInResponse({
      groupLabel: guardianName,
      entries,
      duplicateCount: skippedDuplicate.length,
      skippedDuplicate,
      skippedAbsent,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/sessions/:id/check-in-by-number - Car number check-in
router.post(
  "/sessions/:id/check-in-by-number",
  ...managerAuth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;
      const { carNumber } = req.body;

      if (!carNumber) {
        return res.status(400).json({ error: "carNumber is required" });
      }

      const session = await getSessionById(sessionId);
      if (!session || session.schoolId !== schoolId) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (rejectInactiveSession(res, session)) return;

      let guardianName = `Car #${carNumber}`;
      let studentList: { id: string; homeroomId?: string | null; firstName?: string; lastName?: string }[] = [];

      // Always look up family group by car number (unified — no mode branching)
      const group = await getFamilyGroupByCarNumber(schoolId, carNumber.toString().trim());
      if (!group) {
        return res.status(404).json({ error: "Car number not found" });
      }

      // If a parent claimed this group, use their name
      if (group.claimedByUserId) {
        const parent = await getUserById(group.claimedByUserId);
        if (parent) {
          guardianName = `${parent.firstName} ${parent.lastName}`;
        }
      } else if (group.familyName) {
        guardianName = group.familyName;
      }

      const groupStudents = await getFamilyGroupStudents(group.id);
      const groupStudentIds = groupStudents.map((s: any) => s.id);
      const groupEffective = groupStudentIds.length > 0
        ? await getEffectiveDismissalTypes(groupStudentIds, sessionId)
        : new Map<string, string>();
      studentList = groupStudents
        .filter((s: any) => (groupEffective.get(s.id) ?? s.dismissalType) === "car")
        .map((s: any) => ({ id: s.id, homeroomId: s.homeroomId, firstName: s.firstName, lastName: s.lastName }));

      if (studentList.length === 0) {
        return res
          .status(400)
          .json({ error: "No car-rider students for this number" });
      }

      // Filter out absent students
      const today = await getSchoolLocalDate(schoolId);
      const absentIds = await getAbsentStudentIds(schoolId, today);
      const skippedAbsent = studentList.filter((s) => absentIds.has(s.id));
      studentList = studentList.filter((s) => !absentIds.has(s.id));

      let position = await getMaxQueuePosition(sessionId);
      const entries: Array<{ entry: any; student: CheckInStudentSummary }> = [];
      const skippedDuplicate: CheckInStudentSummary[] = [];

      for (const s of studentList) {
        const alreadyInQueue = await isStudentInQueue(sessionId, s.id);
        if (alreadyInQueue) {
          skippedDuplicate.push(s);
          continue;
        }

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: s.id,
          guardianName,
          pickupGroupId: `family:${group.id}`,
          pickupGroupLabel: guardianName,
          checkInMethod: "car_number",
          position,
        });
        entries.push({ entry, student: s });
        await recordDismissalTimeline({ schoolId, entry, action: "checked in", actorUserId: req.authUser!.id, metadata: { carNumber } });

        if (s.homeroomId) {
          emitToSchool(schoolId, `teacher:${s.homeroomId}`, "student:checked-in", entry);
        }
      }

      // Notify parent app so QR check-in triggers the same queued flow
      if (group.claimedByUserId) {
        emitToSchool(schoolId, `parent:${group.claimedByUserId}`, "student:checked-in", {
          entries: entries.map(({ entry }) => entry),
          carNumber,
        });
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "check_in",
        entries: entries.map(({ entry }) => entry),
        carNumber,
      });

      return res.json(buildCheckInResponse({
        groupLabel: guardianName || `Car #${carNumber}`,
        entries,
        duplicateCount: skippedDuplicate.length,
        skippedDuplicate,
        skippedAbsent,
      }));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/gopilot/dismissal/sessions/:id/check-in-by-bus - Bus number check-in
router.post(
  "/sessions/:id/check-in-by-bus",
  ...managerAuth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;
      const { busNumber } = req.body;

      if (!busNumber) {
        return res.status(400).json({ error: "busNumber is required" });
      }

      const session = await getSessionById(sessionId);
      if (!session || session.schoolId !== schoolId) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (rejectInactiveSession(res, session)) return;

      const routeNumber = busNumber.toString().trim();
      const busStudents = await getStudentsByBusRoute(schoolId, routeNumber);
      const allOverrides = await getOverridesForSession(sessionId);
      const overrideMap = new Map(allOverrides.map((override) => [override.studentId, override]));
      const busStudentsById = new Map(busStudents.map((student) => [student.id, student]));
      const effectiveBusStudents = busStudents.filter((student) => {
        const override = overrideMap.get(student.id);
        if (!override) return true;
        return override.overrideType === "bus" && (override.busRoute ?? student.busRoute) === routeNumber;
      });
      for (const override of allOverrides) {
        if (override.overrideType !== "bus" || override.busRoute !== routeNumber || busStudentsById.has(override.studentId)) {
          continue;
        }
        const student = await getStudentById(override.studentId);
        if (student && student.schoolId === schoolId && student.status === "active") {
          effectiveBusStudents.push(student);
        }
      }

      if (effectiveBusStudents.length === 0) {
        return res
          .status(400)
          .json({ error: "No students on this bus route" });
      }

      // Filter out absent students
      const today = await getSchoolLocalDate(schoolId);
      const absentIds = await getAbsentStudentIds(schoolId, today);
      const skippedAbsent = effectiveBusStudents.filter((s) => absentIds.has(s.id));
      const presentStudents = effectiveBusStudents.filter((s) => !absentIds.has(s.id));

      let position = await getMaxQueuePosition(sessionId);
      const entries: Array<{ entry: any; student: CheckInStudentSummary }> = [];
      const skippedDuplicate: CheckInStudentSummary[] = [];

      for (const student of presentStudents) {
        const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
        if (alreadyInQueue) {
          skippedDuplicate.push(student);
          continue;
        }

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: student.id,
          guardianName: `Bus #${routeNumber}`,
          pickupGroupId: `bus:${routeNumber}`,
          pickupGroupLabel: `Bus #${routeNumber}`,
          checkInMethod: "bus_number",
          position,
        });
        entries.push({ entry, student });
        await recordDismissalTimeline({ schoolId, entry, action: "checked in", actorUserId: req.authUser!.id, metadata: { busNumber: routeNumber } });

        if (student.homeroomId) {
          emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:checked-in", entry);
        }
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "check_in",
        entries: entries.map(({ entry }) => entry),
        busNumber: routeNumber,
      });

      return res.json(buildCheckInResponse({
        groupLabel: `Bus #${routeNumber}`,
        entries,
        duplicateCount: skippedDuplicate.length,
        skippedDuplicate,
        skippedAbsent,
      }));
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Queue Operations
// ============================================================================

// POST /api/gopilot/dismissal/sessions/:id/call - Call individual student
router.post("/sessions/:id/call", ...managerAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const { queueId, zone } = req.body;
    if (!queueId) {
      return res.status(400).json({ error: "queueId is required" });
    }
    const session = await getSessionForSchool(sessionId, schoolId);
    const original = await getQueueEntryForSchool(queueId, schoolId);
    if (!session || !original || original.sessionId !== sessionId) {
      return res.status(404).json({ error: "Queue entry not found" });
    }
    if (rejectInactiveSession(res, session)) return;
    if (!["waiting", "called", "held", "delayed"].includes(original.status)) {
      return res.status(409).json({ error: "Only waiting, called, held, or delayed students can be called" });
    }

    const entry = await callQueueEntry(queueId, zone);
    if (!entry) {
      return res.status(409).json({ error: "Queue entry is not eligible to be called" });
    }

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "called",
      entry,
    });

    // Notify teacher homeroom
    if (original) {
      const student = await getStudentById(original.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:called", {
          entry,
          zone,
        });
      }

      // Notify parent
      if (original.guardianId) {
        emitToSchool(schoolId, `parent:${original.guardianId}`, "student:called", {
          entry,
          zone,
        });
      }
    }

    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/sessions/:id/call-batch - Call next batch
router.post("/sessions/:id/call-batch", ...managerAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(sessionId, schoolId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (rejectInactiveSession(res, session)) return;
    const count = req.body.count ?? 5;
    const zone = req.body.zone || null;

    const entries = await callNextBatch(sessionId, count, zone);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_called",
      entries,
    });

    // Notify teacher/parent rooms for each entry
    for (const entry of entries) {
      const student = await getStudentById(entry.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:called", {
          entry,
          zone,
        });
      }
      if (entry.guardianId) {
        emitToSchool(schoolId, `parent:${entry.guardianId}`, "student:called", {
          entry,
          zone,
        });
      }
    }

    return res.json({ called: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/:id/release - Release student
router.post("/queue/:id/release", ...staffAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const original = await getQueueEntryForSchool(id, schoolId);
    if (!original) {
      return res.status(404).json({ error: "Queue entry not found" });
    }
    const session = await getSessionForSchool(original.sessionId, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (original.status !== "called") {
      return res.status(409).json({ error: "Student must be called before release" });
    }
    const role = await getRequestGoPilotRole(req, res);
    if (!isGoPilotManager(role) && !(await canAccessStudent(req.authUser!, schoolId, original.studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const entry = await releaseQueueEntry(id);
    if (!entry) {
      return res.status(404).json({ error: "Queue entry not found or invalid status" });
    }
    await recordDismissalTimeline({ schoolId, entry, action: "released", actorUserId: req.authUser!.id });

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "released",
      entry,
    });

    const student = await getStudentById(entry.studentId);
    if (student?.homeroomId) {
      emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:released", {
        entry,
      });
    }
    if (entry.guardianId) {
      emitToSchool(schoolId, `parent:${entry.guardianId}`, "student:released", {
        entry,
      });
    }

    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/:id/dismiss - Dismiss student
router.post("/queue/:id/dismiss", ...managerAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const original = await getQueueEntryForSchool(id, schoolId);
    if (!original) {
      return res.status(404).json({ error: "Queue entry not found" });
    }
    const session = await getSessionForSchool(original.sessionId, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (original.status !== "released") {
      return res.status(409).json({ error: "Student must be released before pickup completion" });
    }
    const custodyAlerts = await getActiveCustodyAlertsForStudent(original.studentId);
    if (custodyAlerts.length > 0 && req.body?.custodyAcknowledged !== true) {
      return res.status(409).json({
        error: "Custody alert acknowledgement is required before pickup completion",
        custodyAlerts: serializeCustodyAlerts(custodyAlerts),
      });
    }

    const entry = await dismissQueueEntry(id);
    if (!entry) {
      return res.status(404).json({ error: "Queue entry not found or invalid status" });
    }
    await recordDismissalTimeline({
      schoolId,
      entry,
      action: "dismissed",
      actorUserId: req.authUser!.id,
      metadata: {
        custodyAcknowledged: custodyAlerts.length > 0 ? true : undefined,
        custodyAlertIds: custodyAlerts.map((alert) => alert.id),
        pickupPersonName: req.body?.pickupPersonName || null,
        pickupNote: req.body?.pickupNote || null,
      },
    });

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "dismissed",
      entry,
    });

    const student = await getStudentById(entry.studentId);
    if (student?.homeroomId) {
      emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:dismissed", {
        entry,
      });
    }
    if (entry.guardianId) {
      emitToSchool(schoolId, `parent:${entry.guardianId}`, "student:dismissed", {
        entry,
      });
    }

    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/dismiss-batch - Batch dismiss
router.post("/queue/dismiss-batch", ...managerAuth, async (req, res, next) => {
  try {
    const { queueIds, pickupGroupId } = req.body;
    if (!Array.isArray(queueIds) || queueIds.length === 0) {
      return res.status(400).json({ error: "queueIds array required" });
    }
    const ids = queueIds.map(String);
    const schoolId = res.locals.schoolId!;
    const entriesForSchool = await Promise.all(
      ids.map((id) => getQueueEntryForSchool(id, schoolId))
    );
    if (entriesForSchool.some((entry) => !entry)) {
      return res.status(404).json({ error: "One or more queue entries not found" });
    }
    const sessionIds = [...new Set(entriesForSchool.map((entry) => entry!.sessionId))];
    if (sessionIds.length !== 1) {
      return res.status(409).json({ error: "Batch pickup entries must belong to one session" });
    }
    const session = await getSessionForSchool(sessionIds[0]!, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (entriesForSchool.some((entry) => entry!.status !== "released")) {
      return res.status(409).json({ error: "All students must be released before pickup completion" });
    }
    if (!pickupGroupId || entriesForSchool.some((entry) => !entry!.pickupGroupId || entry!.pickupGroupId !== pickupGroupId)) {
      return res.status(409).json({ error: "Stable pickupGroupId is required for batch pickup completion" });
    }

    const custodyByQueueId = new Map<string, ReturnType<typeof serializeCustodyAlerts>>();
    const dismissibleIds: string[] = [];
    for (const entry of entriesForSchool) {
      const alerts = await getActiveCustodyAlertsForStudent(entry!.studentId);
      if (alerts.length > 0) {
        custodyByQueueId.set(entry!.id, serializeCustodyAlerts(alerts));
      } else {
        dismissibleIds.push(entry!.id);
      }
    }

    const entries = dismissibleIds.length > 0 ? await batchDismiss(dismissibleIds) : [];
    await Promise.all(entries.map((entry) =>
      recordDismissalTimeline({ schoolId, entry, action: "dismissed", actorUserId: req.authUser!.id })
    ));

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_dismissed",
      entries,
    });

    return res.json({
      dismissed: entries.length,
      entries,
      skippedCustody: [...custodyByQueueId.entries()].map(([queueId, custodyAlerts]) => ({ queueId, custodyAlerts })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/release-batch - Batch release
router.post("/queue/release-batch", ...staffAuth, async (req, res, next) => {
  try {
    const { queueIds } = req.body;
    if (!Array.isArray(queueIds) || queueIds.length === 0) {
      return res.status(400).json({ error: "queueIds array required" });
    }
    const ids = queueIds.map(String);
    const schoolId = res.locals.schoolId!;
    const role = await getRequestGoPilotRole(req, res);
    const entriesForSchool = await Promise.all(
      ids.map((id) => getQueueEntryForSchool(id, schoolId))
    );
    if (entriesForSchool.some((entry) => !entry)) {
      return res.status(404).json({ error: "One or more queue entries not found" });
    }
    const sessionIds = [...new Set(entriesForSchool.map((entry) => entry!.sessionId))];
    if (sessionIds.length !== 1) {
      return res.status(409).json({ error: "Batch release entries must belong to one session" });
    }
    const session = await getSessionForSchool(sessionIds[0]!, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (entriesForSchool.some((entry) => entry!.status !== "called")) {
      return res.status(409).json({ error: "All students must be called before release" });
    }
    if (!isGoPilotManager(role)) {
      for (const entry of entriesForSchool) {
        if (!entry || !(await canAccessStudent(req.authUser!, schoolId, entry.studentId, role))) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
      }
    }

    const entries = await batchRelease(ids);
    await Promise.all(entries.map((entry) =>
      recordDismissalTimeline({ schoolId, entry, action: "released", actorUserId: req.authUser!.id })
    ));

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_released",
      entries,
    });
    for (const entry of entries) {
      const student = await getStudentById(entry.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:released", { entry });
      }
      if (entry.guardianId) {
        emitToSchool(schoolId, `parent:${entry.guardianId}`, "student:released", { entry });
      }
    }

    return res.json({ released: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Walker Release
// ============================================================================

// POST /api/gopilot/dismissal/sessions/:id/release-walkers
router.post(
  "/sessions/:id/release-walkers",
  ...managerAuth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;
      const session = await getSessionForSchool(sessionId, schoolId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (rejectInactiveSession(res, session)) return;

      return res.json(await releaseWalkerStudents({
        schoolId,
        sessionId,
        actorUserId: req.authUser!.id,
      }));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/gopilot/dismissal/sessions/:id/release-walkers-by-filter
router.post(
  "/sessions/:id/release-walkers-by-filter",
  ...managerAuth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;
      const session = await getSessionForSchool(sessionId, schoolId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (rejectInactiveSession(res, session)) return;
      const { filterType, filterValues } = req.body;

      if (!["grade", "homeroom"].includes(filterType) || !Array.isArray(filterValues)) {
        return res
          .status(400)
          .json({ error: "filterType must be grade or homeroom and filterValues must be an array" });
      }

      return res.json(await releaseWalkerStudents({
        schoolId,
        sessionId,
        actorUserId: req.authUser!.id,
        filter: { filterType, filterValues: filterValues.map(String) },
      }));
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Hold & Delay
// ============================================================================

// POST /api/gopilot/dismissal/queue/:id/hold - Hold student
router.post("/queue/:id/hold", ...managerAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const original = await getQueueEntryForSchool(id, res.locals.schoolId!);
    if (!original) {
      return res.status(404).json({ error: "Queue entry not found" });
    }
    const { reason } = req.body;

    const entry = await holdQueueEntry(id, reason);
    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/:id/delay - Delay student 2 minutes
router.post("/queue/:id/delay", ...managerAuth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const original = await getQueueEntryForSchool(id, res.locals.schoolId!);
    if (!original) {
      return res.status(404).json({ error: "Queue entry not found" });
    }

    const entry = await delayQueueEntry(id);
    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Stats & Activity
// ============================================================================

// GET /api/gopilot/dismissal/sessions/:id/stats
router.get("/sessions/:id/stats", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const session = await getSessionForSchool(sessionId, res.locals.schoolId!);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const stats = await getSessionStats(sessionId);
    return res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id/activity
router.get("/sessions/:id/activity", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const session = await getSessionForSchool(sessionId, res.locals.schoolId!);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const log = await getActivityLog(sessionId);
    return res.json(log);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Dismissal Overrides (session-scoped daily type changes)
// ============================================================================

const VALID_OVERRIDE_TYPES = ["car", "bus", "walker", "afterschool"];

// POST /api/gopilot/dismissal/sessions/:id/override
router.post("/sessions/:id/override", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const userId = req.authUser!.id;
    const role = await getRequestGoPilotRole(req, res);
    const { studentId, overrideType, reason } = req.body;
    let { busRoute } = req.body;

    if (!studentId || !overrideType) {
      return res.status(400).json({ error: "studentId and overrideType are required" });
    }
    if (!VALID_OVERRIDE_TYPES.includes(overrideType)) {
      return res.status(400).json({ error: `overrideType must be one of: ${VALID_OVERRIDE_TYPES.join(", ")}` });
    }
    if (overrideType === "afterschool" && !reason) {
      return res.status(400).json({ error: "reason is required for afterschool override (e.g., activity name)" });
    }

    // Verify session
    const session = await getSessionById(sessionId);
    if (!session || session.schoolId !== schoolId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (rejectInactiveSession(res, session)) return;

    // Verify student belongs to school
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    if (overrideType === "bus") {
      busRoute = String(busRoute || student.busRoute || "").trim();
      if (!busRoute) {
        return res.status(400).json({ error: "busRoute is required for bus overrides" });
      }
    } else {
      busRoute = null;
    }

    const [queuedEntry] = await db
      .select()
      .from(dismissalQueue)
      .where(and(eq(dismissalQueue.sessionId, sessionId), eq(dismissalQueue.studentId, studentId)))
      .limit(1);
    if (queuedEntry && queuedEntry.status !== "waiting") {
      return res.status(409).json({ error: "Queued students can only be reclassified before they are called" });
    }

    // Role-based access check
    let changedByRole = "office";
    if (role === "parent") {
      changedByRole = "parent";
      const links = await getParentStudents(userId);
      const isLinked = links.some((l) => l.studentId === studentId && l.status === "approved");
      if (!isLinked) {
        return res.status(403).json({ error: "You are not linked to this student" });
      }
    } else if (role === "teacher") {
      changedByRole = "teacher";
      if (!student.homeroomId) {
        return res.status(403).json({ error: "Student is not in your homeroom" });
      }
      const teachers = await getHomeroomTeachers(student.homeroomId);
      const isTeacher = teachers.some((t) => t.teacherId === userId);
      if (!isTeacher) {
        return res.status(403).json({ error: "Student is not in your homeroom" });
      }
    } else if (!isGoPilotManager(role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    // admin, school_admin, office_staff can override any student

    const override = await upsertDismissalOverride({
      sessionId,
      studentId,
      originalType: student.dismissalType ?? "car",
      overrideType,
      busRoute,
      reason: reason || null,
      changedBy: userId,
      changedByRole,
    });

    if (queuedEntry && overrideType === "afterschool") {
      await db
        .delete(dismissalQueue)
        .where(
          and(
            eq(dismissalQueue.sessionId, sessionId),
            eq(dismissalQueue.studentId, studentId)
          )
        );
    } else if (queuedEntry) {
      const queueUpdate =
        overrideType === "bus"
          ? {
              checkInMethod: "bus_number",
              guardianName: `Bus #${busRoute}`,
              pickupGroupId: `bus:${busRoute}`,
              pickupGroupLabel: `Bus #${busRoute}`,
            }
          : overrideType === "walker"
            ? {
                checkInMethod: "walker",
                guardianName: "Walkers",
                pickupGroupId: "walkers:override",
                pickupGroupLabel: "Walkers",
              }
            : {
                checkInMethod: "car_number",
                pickupGroupId: queuedEntry.pickupGroupId,
                pickupGroupLabel: queuedEntry.pickupGroupLabel,
              };
      await updateQueueEntry(queuedEntry.id, queueUpdate);
    }
    if (queuedEntry) {
      emitToSchool(schoolId, "office", "queue:updated", {
        action: "override_reclassified",
        studentId,
      });
    }

    // Emit socket event
    const changer = await getUserById(userId);
    const changerName = changer ? `${changer.firstName} ${changer.lastName}` : "Unknown";

    const overrideEvent = {
      studentId,
      studentName: `${student.firstName} ${student.lastName}`,
      originalType: student.dismissalType ?? "car",
      overrideType,
      busRoute,
      changedBy: changerName,
      changedByRole,
      reason: reason || null,
    };

    emitToSchool(schoolId, "office", "dismissal:override", overrideEvent);
    if (student.homeroomId) {
      emitToSchool(schoolId, `teacher:${student.homeroomId}`, "dismissal:override", overrideEvent);
    }
    // Notify parent if changed by teacher/office
    if (changedByRole !== "parent") {
      const parentLinks = await db
        .select({ parentId: parentStudent.parentId })
        .from(parentStudent)
        .where(
          and(
            eq(parentStudent.studentId, studentId),
            eq(parentStudent.status, "approved")
          )
        );
      for (const link of parentLinks) {
        emitToSchool(schoolId, `parent:${link.parentId}`, "dismissal:override", overrideEvent);
      }
    }

    await recordDismissalTimeline({
      schoolId,
      studentId,
      sourceId: override.id,
      action: "override",
      actorUserId: userId,
      summary: `${student.dismissalType ?? "car"} to ${overrideType}${reason ? `: ${reason}` : ""}`,
      metadata: overrideEvent,
    });

    return res.status(201).json({ override });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id/overrides
router.get("/sessions/:id/overrides", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(sessionId, schoolId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const role = await getRequestGoPilotRole(req, res);
    const parentStudentIds = role === "parent"
      ? await getApprovedParentStudentIds(req.authUser!.id, schoolId)
      : null;
    const teacherHomeroomIds = role === "teacher"
      ? await getTeacherHomeroomIds(req.authUser!.id, schoolId)
      : null;
    const overrides = await getOverridesForSession(sessionId);

    // Enrich with student names
    const enriched = await Promise.all(
      overrides.map(async (o) => {
        const student = await getStudentById(o.studentId);
        if (!student || student.schoolId !== schoolId) return null;
        if (role === "parent" && !parentStudentIds?.has(o.studentId)) return null;
        if (role === "teacher" && (!student.homeroomId || !teacherHomeroomIds?.has(student.homeroomId))) return null;
        if (!isGoPilotManager(role) && role !== "parent" && role !== "teacher") return null;
        const changer = await getUserById(o.changedBy);
        return {
          ...o,
          studentName: student ? `${student.firstName} ${student.lastName}` : null,
          homeroomId: student?.homeroomId ?? null,
          changedByName: changer ? `${changer.firstName} ${changer.lastName}` : null,
        };
      })
    );

    return res.json({ overrides: enriched.filter(Boolean) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/dismissal/sessions/:id/override/:studentId
router.delete("/sessions/:id/override/:studentId", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const studentId = param(req, "studentId");
    const schoolId = res.locals.schoolId!;

    const session = await getSessionById(sessionId);
    if (!session || session.schoolId !== schoolId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (rejectInactiveSession(res, session)) return;
    const role = await getRequestGoPilotRole(req, res);
    if (!(await canAccessStudent(req.authUser!, schoolId, studentId, role))) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    const [queuedEntry] = await db
      .select()
      .from(dismissalQueue)
      .where(and(eq(dismissalQueue.sessionId, sessionId), eq(dismissalQueue.studentId, studentId)))
      .limit(1);
    if (queuedEntry && queuedEntry.status !== "waiting") {
      return res.status(409).json({ error: "Queued students can only be reverted before they are called" });
    }

    const deleted = await deleteDismissalOverride(sessionId, studentId);
    if (!deleted) {
      return res.status(404).json({ error: "No override found for this student" });
    }
    if (queuedEntry) {
      if ((student.dismissalType ?? "car") === "afterschool") {
        await db
          .delete(dismissalQueue)
          .where(and(eq(dismissalQueue.sessionId, sessionId), eq(dismissalQueue.studentId, studentId)));
      } else {
        const permanentType = student.dismissalType ?? "car";
        await updateQueueEntry(queuedEntry.id, {
          checkInMethod: permanentType === "bus" ? "bus_number" : permanentType === "walker" ? "walker" : "car_number",
          guardianName: permanentType === "bus" && student.busRoute ? `Bus #${student.busRoute}` : permanentType === "walker" ? "Walkers" : queuedEntry.guardianName,
          pickupGroupId: permanentType === "bus" && student.busRoute ? `bus:${student.busRoute}` : permanentType === "walker" ? "walkers:revert" : queuedEntry.pickupGroupId,
          pickupGroupLabel: permanentType === "bus" && student.busRoute ? `Bus #${student.busRoute}` : permanentType === "walker" ? "Walkers" : queuedEntry.pickupGroupLabel,
        });
      }
      emitToSchool(schoolId, "office", "queue:updated", {
        action: "override_reverted",
        studentId,
      });
    }

    // Emit revert event
    if (student) {
      const revertEvent = {
        studentId,
        studentName: `${student.firstName} ${student.lastName}`,
        originalType: student.dismissalType ?? "car",
        overrideType: null,
        busRoute: student.busRoute ?? null,
        changedBy: "System",
        changedByRole: "system",
        reason: "Override reverted",
      };
      emitToSchool(schoolId, "office", "dismissal:override", revertEvent);
      if (student.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "dismissal:override", revertEvent);
      }
      await recordDismissalTimeline({
        schoolId,
        studentId,
        action: "override reverted",
        actorUserId: req.authUser!.id,
        summary: "Dismissal override reverted",
        metadata: revertEvent,
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
