import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getSchoolById,
  getSessionById,
  getOrCreateSession,
  updateSessionStatus,
  getQueueBySession,
  getQueueEntryById,
  getMaxQueuePosition,
  isStudentInQueue,
  addToQueue,
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
  getMemberByCarNumber,
} from "../../services/storage.js";
import { getIO } from "../../realtime/socketio.js";

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

function emitToSchool(schoolId: string, room: string, event: string, data: unknown) {
  const io = getIO();
  if (io) io.to(`school:${schoolId}:${room}`).emit(event, data);
}

// ============================================================================
// Session Management
// ============================================================================

// POST /api/gopilot/dismissal/sessions - Create or get today's session
router.post("/sessions", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const school = await getSchoolById(schoolId);
    const timeZone = school?.schoolTimezone ?? "America/New_York";
    const localDate = new Date().toLocaleDateString("en-CA", { timeZone });

    const session = await getOrCreateSession(schoolId, localDate);
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id
router.get("/sessions/:id", ...auth, async (req, res, next) => {
  try {
    const session = await getSessionById(param(req, "id"));
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/dismissal/sessions/:id - Update session status (start/pause/complete)
router.put("/sessions/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { status } = req.body;

    const session = await updateSessionStatus(id, status);
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
    const filterStatus = (req.query.status as string) || undefined;

    const entries = await getQueueBySession(sessionId, filterStatus);

    // Enrich each entry with student and homeroom data
    const queue = await Promise.all(
      entries.map(async (entry) => {
        const student = await getStudentById(entry.studentId);
        let homeroomName: string | null = null;
        if (student?.homeroomId) {
          const homeroom = await getHomeroomById(student.homeroomId);
          homeroomName = homeroom?.name ?? null;
        }
        return {
          ...entry,
          firstName: student?.firstName ?? null,
          lastName: student?.lastName ?? null,
          dismissalType: student?.dismissalType ?? null,
          busRoute: student?.busRoute ?? null,
          homeroomName,
        };
      })
    );

    return res.json({ queue });
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

    // Get parent's car-rider children
    const carRiders = await getCarRiderChildrenForParent(userId, schoolId);
    if (carRiders.length === 0) {
      return res.status(400).json({ error: "No car-rider children found" });
    }

    const guardian = await getUserById(userId);
    const guardianName = guardian
      ? `${guardian.firstName} ${guardian.lastName}`
      : "Unknown";

    let position = await getMaxQueuePosition(sessionId);
    const entries: unknown[] = [];

    for (const student of carRiders) {
      const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
      if (alreadyInQueue) continue;

      position++;
      const entry = await addToQueue({
        sessionId,
        studentId: student.id,
        guardianId: userId,
        guardianName,
        checkInMethod: "app",
        position,
      });
      entries.push(entry);

      // Notify teacher homeroom
      if (student.homeroomId) {
        emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:checked-in", entry);
      }
    }

    emitToSchool(schoolId, "office", "queue:updated", {
      action: "check_in",
      entries,
    });

    return res.json({ entries, position });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/sessions/:id/check-in-by-number - Car number check-in
router.post(
  "/sessions/:id/check-in-by-number",
  ...auth,
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

      const school = await getSchoolById(schoolId);
      let guardianName = `Car #${carNumber}`;
      let studentList: { id: string; homeroomId?: string | null }[] = [];

      if (school?.dismissalMode === "no_app") {
        // No-app mode: look up family group by car number
        const group = await getFamilyGroupByCarNumber(schoolId, carNumber);
        if (!group) {
          return res.status(404).json({ error: "Car number not found" });
        }
        const groupStudents = await getFamilyGroupStudents(group.id);
        studentList = groupStudents
          .filter((s: any) => s.dismissalType === "car")
          .map((s: any) => ({ id: s.id, homeroomId: s.homeroomId }));
      } else {
        // App mode: look up parent membership by car number
        const member = await getMemberByCarNumber(schoolId, carNumber);
        if (!member) {
          return res.status(404).json({ error: "Car number not found" });
        }
        const parentId = member.userId;
        const parent = await getUserById(parentId);
        if (parent) {
          guardianName = `${parent.firstName} ${parent.lastName}`;
        }
        const carRiders = await getCarRiderChildrenForParent(parentId, schoolId);
        studentList = carRiders.map((r: any) => {
          const s = r.student ?? r;
          return { id: s.id, homeroomId: s.homeroomId };
        });
      }

      if (studentList.length === 0) {
        return res
          .status(400)
          .json({ error: "No car-rider students for this number" });
      }

      let position = await getMaxQueuePosition(sessionId);
      const entries: unknown[] = [];

      for (const s of studentList) {
        const alreadyInQueue = await isStudentInQueue(sessionId, s.id);
        if (alreadyInQueue) continue;

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: s.id,
          guardianName,
          checkInMethod: "car_number",
          position,
        });
        entries.push(entry);

        if (s.homeroomId) {
          emitToSchool(schoolId, `teacher:${s.homeroomId}`, "student:checked-in", entry);
        }
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "check_in",
        entries,
        carNumber,
      });

      return res.json({ entries, position, carNumber });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/gopilot/dismissal/sessions/:id/check-in-by-bus - Bus number check-in
router.post(
  "/sessions/:id/check-in-by-bus",
  ...auth,
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

      const busStudents = await getStudentsByBusRoute(schoolId, busNumber);
      if (busStudents.length === 0) {
        return res
          .status(400)
          .json({ error: "No students on this bus route" });
      }

      let position = await getMaxQueuePosition(sessionId);
      const entries: unknown[] = [];

      for (const student of busStudents) {
        const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
        if (alreadyInQueue) continue;

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: student.id,
          guardianName: `Bus #${busNumber}`,
          checkInMethod: "bus_number",
          position,
        });
        entries.push(entry);

        if (student.homeroomId) {
          emitToSchool(schoolId, `teacher:${student.homeroomId}`, "student:checked-in", entry);
        }
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "check_in",
        entries,
        busNumber,
      });

      return res.json({ entries, position, busNumber });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Queue Operations
// ============================================================================

// POST /api/gopilot/dismissal/sessions/:id/call - Call individual student
router.post("/sessions/:id/call", ...auth, async (req, res, next) => {
  try {
    const { queueId, zone } = req.body;
    if (!queueId) {
      return res.status(400).json({ error: "queueId is required" });
    }

    const entry = await callQueueEntry(queueId, zone);

    const schoolId = res.locals.schoolId!;
    emitToSchool(schoolId, "office", "queue:updated", {
      action: "called",
      entry,
    });

    // Notify teacher homeroom
    const original = await getQueueEntryById(queueId);
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
router.post("/sessions/:id/call-batch", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const count = req.body.count ?? 5;
    const zone = req.body.zone || null;

    const entries = await callNextBatch(sessionId, count, zone);

    const schoolId = res.locals.schoolId!;
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
router.post("/queue/:id/release", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const entry = await releaseQueueEntry(id);
    if (!entry) {
      return res.status(404).json({ error: "Queue entry not found or invalid status" });
    }

    const schoolId = res.locals.schoolId!;
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
router.post("/queue/:id/dismiss", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const entry = await dismissQueueEntry(id);
    if (!entry) {
      return res.status(404).json({ error: "Queue entry not found or invalid status" });
    }

    const schoolId = res.locals.schoolId!;
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
router.post("/queue/dismiss-batch", ...auth, async (req, res, next) => {
  try {
    const { queueIds } = req.body;
    if (!Array.isArray(queueIds) || queueIds.length === 0) {
      return res.status(400).json({ error: "queueIds array required" });
    }

    const entries = await batchDismiss(queueIds);

    const schoolId = res.locals.schoolId!;
    emitToSchool(schoolId, "office", "queue:updated", {
      action: "batch_dismissed",
      entries,
    });

    return res.json({ dismissed: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/release-batch - Batch release
router.post("/queue/release-batch", ...auth, async (req, res, next) => {
  try {
    const { queueIds } = req.body;
    if (!Array.isArray(queueIds) || queueIds.length === 0) {
      return res.status(400).json({ error: "queueIds array required" });
    }

    const entries = await batchRelease(queueIds);

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
  ...auth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;

      const walkers = await getStudentsByDismissalType(schoolId, "walker");
      if (walkers.length === 0) {
        return res.json({ entries: [], position: 0 });
      }

      let position = await getMaxQueuePosition(sessionId);
      const entries: unknown[] = [];

      for (const student of walkers) {
        const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
        if (alreadyInQueue) continue;

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: student.id,
          guardianName: "Walkers",
          checkInMethod: "walker",
          status: "dismissed",
          dismissedAt: new Date(),
          position,
        });
        entries.push(entry);
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "walkers_released",
        entries,
      });

      return res.json({ entries, position });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/gopilot/dismissal/sessions/:id/release-walkers-by-filter
router.post(
  "/sessions/:id/release-walkers-by-filter",
  ...auth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "id");
      const schoolId = res.locals.schoolId!;
      const { filterType, filterValues } = req.body;

      if (!filterType || !Array.isArray(filterValues)) {
        return res
          .status(400)
          .json({ error: "filterType and filterValues required" });
      }

      let walkers: Awaited<ReturnType<typeof getStudentsByDismissalType>> = [];
      for (const val of filterValues) {
        const filter =
          filterType === "grade" ? { grade: val } : { homeroomId: val };
        const batch = await getStudentsByDismissalType(
          schoolId,
          "walker",
          filter
        );
        walkers.push(...batch);
      }

      if (walkers.length === 0) {
        return res.json({ entries: [], position: 0 });
      }

      let position = await getMaxQueuePosition(sessionId);
      const entries: unknown[] = [];

      for (const student of walkers) {
        const alreadyInQueue = await isStudentInQueue(sessionId, student.id);
        if (alreadyInQueue) continue;

        position++;
        const entry = await addToQueue({
          sessionId,
          studentId: student.id,
          guardianName: "Walkers",
          checkInMethod: "walker",
          status: "dismissed",
          dismissedAt: new Date(),
          position,
        });
        entries.push(entry);
      }

      emitToSchool(schoolId, "office", "queue:updated", {
        action: "walkers_released",
        entries,
      });

      return res.json({ entries, position });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// Hold & Delay
// ============================================================================

// POST /api/gopilot/dismissal/queue/:id/hold - Hold student
router.post("/queue/:id/hold", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { reason } = req.body;

    const entry = await holdQueueEntry(id, reason);
    return res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/dismissal/queue/:id/delay - Delay student 2 minutes
router.post("/queue/:id/delay", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");

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
router.get("/sessions/:id/stats", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const stats = await getSessionStats(sessionId);
    return res.json(stats);
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/dismissal/sessions/:id/activity
router.get("/sessions/:id/activity", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
    const log = await getActivityLog(sessionId);
    return res.json(log);
  } catch (err) {
    next(err);
  }
});

export default router;
