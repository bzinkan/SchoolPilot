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
  transitionDismissalSessionStatus,
  getQueueBySession,
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
  logActivity,
  getStudentById,
  getUserById,
  getHomeroomById,
  getStudentsByBusRoute,
  getStudentsByDismissalType,
  getOverridesForSession,
  getOverrideForStudent,
  getEffectiveDismissalType,
  getStudentsByHomeroomId,
  createStudentTimelineEvent,
  searchGoPilotArrivalCandidates,
  createStaffDismissalArrivals,
  createStaffOperationalQueueEntries,
  GoPilotArrivalError,
  type StaffDismissalArrivalSource,
} from "../../services/storage.js";
import {
  canAccessStudent,
  getQueueEntryForSchool,
  getRequestGoPilotRole,
  getSessionForSchool,
  getTeacherHomeroomIds,
  isGoPilotManager,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
import { broadcastGoPilot } from "../../realtime/socketio.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import { db } from "../../db.js";
import { dismissalSessions } from "../../schema/gopilot.js";
import { eq, and } from "drizzle-orm";
import {
  applySessionDismissalOverride,
  GoPilotOverrideConflictError,
  revertSessionDismissalOverride,
} from "../../services/gopilotOverrides.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
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
  void broadcastGoPilot(`school:${schoolId}:${room}`, event, data).catch((error) => {
    console.warn("[GoPilot] Realtime relay failed", {
      event,
      code: (error as NodeJS.ErrnoException).code ?? "RELAY_FAILED",
    });
  });
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
  skippedNotCar?: CheckInStudentSummary[];
}) {
  const skippedDuplicate = options.skippedDuplicate ?? [];
  const skippedNotCar = options.skippedNotCar ?? [];
  const duplicateCount = skippedDuplicate.length || options.duplicateCount;
  return {
    outcome: checkInOutcome(
      options.entries.length,
      duplicateCount,
      options.skippedAbsent.length + skippedNotCar.length
    ),
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
    skippedNotCar: skippedNotCar.map((student) => ({
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

function serializeStaffQueueEntry(entry: any) {
  return {
    id: entry.id,
    queueId: entry.id,
    sessionId: entry.sessionId,
    studentId: entry.studentId,
    pickupGroupId: entry.pickupGroupId ?? null,
    pickupGroupLabel: entry.pickupGroupLabel ?? entry.guardianName ?? null,
    checkInTime: entry.checkInTime ?? null,
    checkInMethod: entry.checkInMethod ?? null,
    status: entry.status,
    zone: entry.zone ?? null,
    calledAt: entry.calledAt ?? null,
    releasedAt: entry.releasedAt ?? null,
    dismissedAt: entry.dismissedAt ?? null,
    holdReason: entry.holdReason ?? null,
    delayedUntil: entry.delayedUntil ?? null,
    position: entry.position ?? null,
    createdAt: entry.createdAt,
  };
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
  const pickupGroupId = options.filter?.filterType && options.filter.filterValues?.length
    ? `walkers:${options.filter.filterType}:${[...options.filter.filterValues].sort().join(",")}`
    : "walkers:all";

  const result = await createStaffOperationalQueueEntries({
    schoolId: options.schoolId,
    sessionId: options.sessionId,
    actorId: options.actorUserId,
    source: "walker",
    studentIds: walkers.map((student) => student.id),
    localDate: today,
    pickupGroupId,
    pickupGroupLabel: "Walkers",
    initialStatus: "dismissed",
  });
  for (const { entry, student } of result.entries) {
    await recordDismissalTimeline({
      schoolId: options.schoolId,
      entry,
      action: "walker released",
      actorUserId: options.actorUserId,
      metadata: options.filter,
    });

    if (student.homeroomId) {
      emitToSchool(options.schoolId, `teacher:${student.homeroomId}`, "student:dismissed", {
        entry: serializeStaffQueueEntry(entry),
      });
    }
  }

  emitToSchool(options.schoolId, "office", "queue:updated", {
    action: "walkers_released",
    entries: result.entries.map(({ entry }) => serializeStaffQueueEntry(entry)),
  });

  return buildCheckInResponse({
    groupLabel: "Walkers",
    entries: result.entries,
    duplicateCount: result.skippedDuplicate.length,
    skippedDuplicate: result.skippedDuplicate,
    skippedAbsent: result.skippedAbsent,
    skippedNotCar: result.skippedWrongType,
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
router.post("/sessions", ...managerAuth, async (req, res, next) => {
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
    const result = await transitionDismissalSessionStatus({
      sessionId: id,
      schoolId,
      nextStatus: status,
      actorId: req.authUser!.id,
    });
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: "Session not found" });
    }
    if (result.outcome === "invalid_status") {
      return res.status(409).json({
        error: "Dismissal session has an invalid legacy status and requires staff review",
        code: "GOPILOT_INVALID_SESSION_STATUS",
      });
    }
    if (result.outcome === "invalid_transition") {
      return res.status(409).json({
        error: `Dismissal session cannot transition from ${result.session.status} to ${status}`,
        code: "GOPILOT_INVALID_SESSION_TRANSITION",
      });
    }
    if (result.outcome === "outstanding") {
      return res.status(409).json({
        error: "Dismissal cannot be completed while students are still outstanding",
        outstanding: result.outstanding,
      });
    }
    const session = result.session;

    if (result.outcome === "updated") {
      await broadcastGoPilot(`school:${schoolId}`, "dismissal:status", { session });
    }
    if (result.outcome === "updated" && status === "active") {
      await broadcastGoPilot(`school:${schoolId}`, "dismissal:started", { sessionId: id, session });
    } else if (result.outcome === "updated" && status === "completed") {
      await broadcastGoPilot(`school:${schoolId}`, "dismissal:ended", { sessionId: id, session });
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
        if (role === "teacher" && (!student.homeroomId || !teacherHomeroomIds?.has(student.homeroomId))) return null;
        if (!isGoPilotManager(role) && role !== "teacher") return null;
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
          pickup_group_id: entry.pickupGroupId,
          pickupGroupId: entry.pickupGroupId,
          pickup_group_label: entry.pickupGroupLabel ?? entry.guardianName ?? null,
          pickupGroupLabel: entry.pickupGroupLabel ?? entry.guardianName ?? null,
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

// Historical parent check-in endpoint is terminally disabled. The common auth
// chain returns the stable 410 response for parents before any session lookup;
// staff receive the same terminal response because arrivals use /arrivals.
router.post("/sessions/:id/check-in", ...auth, (_req, res) =>
  res.status(410).json({
    error: "GoPilot parent portal is disabled",
    code: "GOPILOT_PARENT_PORTAL_DISABLED",
  })
);

async function handleStaffArrivalRequest(
  req: any,
  res: any,
  next: any,
  compatibilitySource?: StaffDismissalArrivalSource
) {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const source = compatibilitySource ?? req.body?.source;
    if (source !== "staff_car_number" && source !== "staff_search") {
      return res.status(400).json({
        error: "source must be staff_car_number or staff_search",
        code: "GOPILOT_INVALID_ARRIVAL_SOURCE",
      });
    }

    const allowedFields = source === "staff_car_number"
      ? new Set(["source", "carNumber"])
      : new Set(["source", "studentIds"]);
    if (!compatibilitySource) {
      const unknownFields = Object.keys(req.body ?? {}).filter((field) => !allowedFields.has(field));
      if (unknownFields.length > 0) {
        return res.status(400).json({
          error: `Unknown arrival field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`,
          code: "GOPILOT_INVALID_ARRIVAL_PAYLOAD",
        });
      }
    }

    const carNumber = typeof req.body?.carNumber === "string"
      ? req.body.carNumber.trim()
      : req.body?.carNumber != null
        ? String(req.body.carNumber).trim()
        : "";
    if (source === "staff_car_number" && !/^[A-Za-z0-9-]{1,64}$/.test(carNumber)) {
      return res.status(400).json({
        error: "A valid carNumber is required",
        code: "GOPILOT_INVALID_CAR_NUMBER",
      });
    }
    if (
      source === "staff_search" &&
      (!Array.isArray(req.body?.studentIds) || req.body.studentIds.length === 0)
    ) {
      return res.status(400).json({
        error: "studentIds must contain at least one student",
        code: "GOPILOT_INVALID_STUDENT_SELECTION",
      });
    }

    const localDate = await getSchoolLocalDate(schoolId);
    const result = await createStaffDismissalArrivals({
      schoolId,
      sessionId,
      actorId: req.authUser!.id,
      source,
      carNumber: source === "staff_car_number" ? carNumber : undefined,
      studentIds: source === "staff_search" ? req.body.studentIds.map(String) : undefined,
      localDate,
    });

    await Promise.all(result.entries.map(async ({ entry, student }) => {
      await recordDismissalTimeline({
        schoolId,
        entry,
        action: "arrived",
        actorUserId: req.authUser!.id,
        metadata: { source },
      });
      if (student.homeroomId) {
        emitToSchool(
          schoolId,
          `teacher:${student.homeroomId}`,
          "student:checked-in",
          serializeStaffQueueEntry(entry)
        );
      }
    }));
    emitToSchool(schoolId, "office", "queue:updated", {
      action: "arrival_created",
      source,
      entries: result.entries.map(({ entry }) => serializeStaffQueueEntry(entry)),
    });

    return res.json(buildCheckInResponse({
      groupLabel: result.groupLabel,
      entries: result.entries,
      duplicateCount: result.skippedDuplicate.length,
      skippedDuplicate: result.skippedDuplicate,
      skippedAbsent: result.skippedAbsent,
      skippedNotCar: result.skippedNotCar,
    }));
  } catch (error) {
    if (error instanceof GoPilotArrivalError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
}

// Safe, same-school staff search. This intentionally exposes only fields needed
// to identify an arrival candidate; unified student/device/PIN fields never cross.
router.get("/sessions/:id/arrival-candidates", ...managerAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2 || query.length > 80) {
      return res.status(400).json({
        error: "q must be between 2 and 80 characters",
        code: "GOPILOT_INVALID_ARRIVAL_QUERY",
      });
    }
    const session = await getSessionForSchool(sessionId, schoolId);
    if (rejectInactiveSession(res, session)) return;
    const localDate = await getSchoolLocalDate(schoolId);
    const candidates = await searchGoPilotArrivalCandidates({
      schoolId,
      sessionId,
      localDate,
      query,
    });
    return res.json({ candidates });
  } catch (error) {
    return next(error);
  }
});

router.post("/sessions/:id/arrivals", ...managerAuth, (req, res, next) =>
  handleStaffArrivalRequest(req, res, next)
);

// POST /api/gopilot/dismissal/sessions/:id/check-in-by-number - Car number check-in
router.post(
  "/sessions/:id/check-in-by-number",
  ...managerAuth,
  (req, res, next) => handleStaffArrivalRequest(req, res, next, "staff_car_number")
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

      const today = await getSchoolLocalDate(schoolId);
      const result = await createStaffOperationalQueueEntries({
        schoolId,
        sessionId,
        actorId: req.authUser!.id,
        source: "bus_number",
        studentIds: effectiveBusStudents.map((student) => student.id),
        localDate: today,
        pickupGroupId: `bus:${routeNumber}`,
        pickupGroupLabel: `Bus #${routeNumber}`,
        busRoute: routeNumber,
      });
      for (const { entry, student } of result.entries) {
        await recordDismissalTimeline({ schoolId, entry, action: "checked in", actorUserId: req.authUser!.id, metadata: { busNumber: routeNumber } });

        if (student.homeroomId) {
          emitToSchool(
            schoolId,
            `teacher:${student.homeroomId}`,
            "student:checked-in",
            serializeStaffQueueEntry(entry)
          );
        }
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "check_in",
        entries: result.entries.map(({ entry }) => serializeStaffQueueEntry(entry)),
        busNumber: routeNumber,
      });

      return res.json(buildCheckInResponse({
        groupLabel: `Bus #${routeNumber}`,
        entries: result.entries,
        duplicateCount: result.skippedDuplicate.length,
        skippedDuplicate: result.skippedDuplicate,
        skippedAbsent: result.skippedAbsent,
        skippedNotCar: result.skippedWrongType,
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

    const entry = await callQueueEntry(queueId, zone, schoolId, sessionId);
    if (!entry) {
      return res.status(409).json({ error: "Queue entry is not eligible to be called" });
    }
    await logActivity({
      schoolId,
      sessionId,
      actorId: req.authUser!.id,
      action: "queue.called",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId, zone: zone ?? null },
    });
    const entryDto = serializeStaffQueueEntry(entry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "called",
      entry: entryDto,
    });

    // Notify teacher homeroom
    if (original) {
      const student = await getStudentById(original.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:called", {
          entry: entryDto,
          zone,
        });
      }

    }

    return res.json({ entry: entryDto });
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

    const entries = await callNextBatch(sessionId, count, zone, schoolId);
    await Promise.all(entries.map((entry) => logActivity({
      schoolId,
      sessionId,
      actorId: req.authUser!.id,
      action: "queue.called",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId, zone, batch: true },
    })));
    const entryDtos = entries.map(serializeStaffQueueEntry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_called",
      entries: entryDtos,
    });

    // Notify assigned teacher rooms for each entry.
    for (const entry of entries) {
      const student = await getStudentById(entry.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:called", {
          entry: serializeStaffQueueEntry(entry),
          zone,
        });
      }
    }

    return res.json({ called: entryDtos.length, entries: entryDtos });
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

    const entry = await releaseQueueEntry(id, schoolId, original.sessionId);
    if (!entry) {
      return res.status(404).json({ error: "Queue entry not found or invalid status" });
    }
    await recordDismissalTimeline({ schoolId, entry, action: "released", actorUserId: req.authUser!.id });
    await logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.released",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId },
    });
    const entryDto = serializeStaffQueueEntry(entry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "released",
      entry: entryDto,
    });

    const student = await getStudentById(entry.studentId);
    if (student?.homeroomId) {
      emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:released", {
        entry: entryDto,
      });
    }

    return res.json({ entry: entryDto });
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
    const dismissal = await dismissQueueEntry(id, schoolId, original.sessionId, {
      custodyAcknowledged: req.body?.custodyAcknowledged === true,
    });
    const custodyAlerts = dismissal.custodyAlerts;
    if (custodyAlerts.length > 0 && req.body?.custodyAcknowledged !== true) {
      return res.status(409).json({
        error: "Custody alert acknowledgement is required before pickup completion",
        custodyAlerts: serializeCustodyAlerts(custodyAlerts),
      });
    }
    const entry = dismissal.entry;
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
    await logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.dismissed",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId },
    });
    const entryDto = serializeStaffQueueEntry(entry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "dismissed",
      entry: entryDto,
    });

    const student = await getStudentById(entry.studentId);
    if (student?.homeroomId) {
      emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:dismissed", {
        entry: entryDto,
      });
    }

    return res.json({ entry: entryDto });
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

    const batch = await batchDismiss(ids, schoolId, sessionIds[0]!);
    const entries = batch.entries;
    const custodyByQueueId = new Map(
      [...batch.custodyAlertsByQueueId].map(([queueId, alerts]) => [
        queueId,
        serializeCustodyAlerts(alerts),
      ])
    );
    await Promise.all(entries.map((entry) =>
      recordDismissalTimeline({ schoolId, entry, action: "dismissed", actorUserId: req.authUser!.id })
    ));
    await Promise.all(entries.map((entry) => logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.dismissed",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId, batch: true },
    })));
    const entryDtos = entries.map(serializeStaffQueueEntry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_dismissed",
      entries: entryDtos,
    });

    return res.json({
      dismissed: entryDtos.length,
      entries: entryDtos,
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

    const entries = await batchRelease(ids, schoolId, sessionIds[0]!);
    await Promise.all(entries.map((entry) =>
      recordDismissalTimeline({ schoolId, entry, action: "released", actorUserId: req.authUser!.id })
    ));
    await Promise.all(entries.map((entry) => logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.released",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId, batch: true },
    })));
    const entryDtos = entries.map(serializeStaffQueueEntry);

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_released",
      entries: entryDtos,
    });
    for (const entry of entries) {
      const student = await getStudentById(entry.studentId);
      if (student?.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:released", {
          entry: serializeStaffQueueEntry(entry),
        });
      }
    }

    return res.json({ released: entryDtos.length, entries: entryDtos });
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
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(original.sessionId, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (!["waiting", "called", "delayed"].includes(original.status)) {
      return res.status(409).json({ error: "Queue entry cannot be held from its current status" });
    }
    const { reason } = req.body;

    const entry = await holdQueueEntry(id, reason, schoolId, original.sessionId);
    if (!entry) {
      return res.status(409).json({ error: "Queue entry is no longer eligible to be held" });
    }
    await logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.held",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId, reason: reason || null },
    });
    const entryDto = serializeStaffQueueEntry(entry);
    emitToSchool(schoolId, "office", "queue:updated", { action: "held", entry: entryDto });
    return res.json({ entry: entryDto });
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
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(original.sessionId, schoolId);
    if (rejectInactiveSession(res, session)) return;
    if (!["waiting", "called", "held"].includes(original.status)) {
      return res.status(409).json({ error: "Queue entry cannot be delayed from its current status" });
    }

    const entry = await delayQueueEntry(id, schoolId, original.sessionId);
    if (!entry) {
      return res.status(409).json({ error: "Queue entry is no longer eligible to be delayed" });
    }
    await logActivity({
      schoolId,
      sessionId: entry.sessionId,
      actorId: req.authUser!.id,
      action: "queue.delayed",
      entityType: "dismissal_queue",
      entityId: entry.id,
      details: { studentId: entry.studentId },
    });
    const entryDto = serializeStaffQueueEntry(entry);
    emitToSchool(schoolId, "office", "queue:updated", { action: "delayed", entry: entryDto });
    return res.json({ entry: entryDto });
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
// The audit stream contains school-wide actor/entity identifiers and operational
// reasons. Teachers use their assigned queue view; only managers may inspect
// the complete session audit trail.
router.get("/sessions/:id/activity", ...managerAuth, async (req, res, next) => {
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
router.post("/sessions/:id/override", ...managerAuth, async (req, res, next) => {
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

    if (!isGoPilotManager(role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const changedByRole = role ?? "office_staff";

    const applied = await applySessionDismissalOverride({
      schoolId,
      sessionId,
      student,
      overrideType,
      busRoute,
      reason: reason || null,
      changedBy: userId,
      changedByRole,
    });
    return res.status(201).json({ override: applied.override });
  } catch (err) {
    if (err instanceof GoPilotOverrideConflictError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id/overrides
router.get("/sessions/:id/overrides", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const schoolId = res.locals.schoolId!;
    const session = await getSessionForSchool(sessionId, schoolId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const role = await getRequestGoPilotRole(req, res);
    const teacherHomeroomIds = role === "teacher"
      ? await getTeacherHomeroomIds(req.authUser!.id, schoolId)
      : null;
    const overrides = await getOverridesForSession(sessionId);

    // Enrich with student names
    const enriched = await Promise.all(
      overrides.map(async (o) => {
        const student = await getStudentById(o.studentId);
        if (!student || student.schoolId !== schoolId) return null;
        if (role === "teacher" && (!student.homeroomId || !teacherHomeroomIds?.has(student.homeroomId))) return null;
        if (!isGoPilotManager(role) && role !== "teacher") return null;
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
router.delete("/sessions/:id/override/:studentId", ...managerAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const studentId = param(req, "studentId");
    const schoolId = res.locals.schoolId!;

    const session = await getSessionById(sessionId);
    if (!session || session.schoolId !== schoolId) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (rejectInactiveSession(res, session)) return;
    const reverted = await revertSessionDismissalOverride({
      schoolId,
      sessionId,
      studentId,
      changedBy: req.authUser!.id,
    });
    if (!reverted) {
      return res.status(404).json({ error: "No override found for this student" });
    }
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof GoPilotOverrideConflictError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export default router;
