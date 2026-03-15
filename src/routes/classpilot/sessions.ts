import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  createTeachingSession,
  endTeachingSession,
  getActiveTeachingSession,
  getTeachingSessionById,
  getSessionSettings,
  upsertSessionSettings,
  getGroupById,
  getGroupStudents,
  getHeartbeatsForStudentsInRange,
} from "../../services/storage.js";
import { sendSessionSummaryEmail } from "../../services/email.js";

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

// POST /api/classpilot/teaching-sessions/start - Alias for creating a session
router.post("/start", ...auth, async (req, res, next) => {
  try {
    const { groupId } = req.body;
    const teacherId = req.authUser!.id;

    if (!groupId) {
      return res.status(400).json({ error: "groupId is required" });
    }

    const group = await getGroupById(groupId);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    const existing = await getActiveTeachingSession(teacherId);
    if (existing) {
      await endTeachingSession(existing.id);
    }

    const session = await createTeachingSession({ groupId, teacherId });
    return res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions/end - End the active session
router.post("/end", ...auth, async (req, res, next) => {
  try {
    const existing = await getActiveTeachingSession(req.authUser!.id);
    if (!existing) {
      return res.status(404).json({ error: "No active session" });
    }

    const session = await endTeachingSession(existing.id);
    res.json({ session });

    // Fire-and-forget: send session summary email to teacher
    if (session?.startTime && session?.endTime) {
      buildAndSendSessionSummary(session, req.authUser!).catch((err) =>
        console.error("[SessionSummary] Failed to send:", err)
      );
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions - Start a teaching session
router.post("/", ...auth, async (req, res, next) => {
  try {
    const { groupId } = req.body;
    const teacherId = req.authUser!.id;

    if (!groupId) {
      return res.status(400).json({ error: "groupId is required" });
    }

    const group = await getGroupById(groupId);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // End any existing active session for this teacher
    const existing = await getActiveTeachingSession(teacherId);
    if (existing) {
      await endTeachingSession(existing.id);
    }

    const session = await createTeachingSession({ groupId, teacherId });
    return res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/teaching-sessions/active - Get current active session
router.get("/active", ...auth, async (req, res, next) => {
  try {
    const session = await getActiveTeachingSession(req.authUser!.id);
    if (!session) {
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
    const session = await getTeachingSessionById(param(req, "id"));
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const settings = await getSessionSettings(session.id);
    return res.json({ session, settings });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teaching-sessions/:id/end - End a teaching session
router.post("/:id/end", ...auth, async (req, res, next) => {
  try {
    const session = await endTeachingSession(param(req, "id"));
    return res.json({ session });
  } catch (err) {
    next(err);
  }
});

// PUT /api/classpilot/teaching-sessions/:id/settings - Update session settings
router.put("/:id/settings", ...auth, async (req, res, next) => {
  try {
    const sessionId = param(req, "id");
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

// Build and send session summary email (called async after response)
async function buildAndSendSessionSummary(
  session: { id: string; groupId: string; startTime: Date; endTime: Date | null },
  teacher: { email: string; firstName?: string; lastName?: string }
) {
  const endTime = session.endTime ?? new Date();
  const group = await getGroupById(session.groupId);
  const className = (group as any)?.name || "Class";

  const groupStudentRows = await getGroupStudents(session.groupId);
  const studentIds = groupStudentRows.map((gs) => gs.studentId);

  const hbs = await getHeartbeatsForStudentsInRange(studentIds, session.startTime, endTime);

  // Build per-student domain summaries
  const studentMap = new Map<string, { name: string; domainSeconds: Map<string, number>; count: number }>();
  for (const gs of groupStudentRows) {
    const name = [gs.student.firstName, gs.student.lastName].filter(Boolean).join(" ") || gs.student.email || "Unknown";
    studentMap.set(gs.studentId, { name, domainSeconds: new Map(), count: 0 });
  }

  for (const hb of hbs) {
    if (!hb.studentId) continue;
    const entry = studentMap.get(hb.studentId);
    if (!entry) continue;
    entry.count++;
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
    return { name: s.name, totalMinutes: Math.round((s.count * 10) / 60), topDomains };
  });

  const durationMs = endTime.getTime() - session.startTime.getTime();
  const durationMin = Math.round(durationMs / 60000);
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true });
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });

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
}

export default router;
