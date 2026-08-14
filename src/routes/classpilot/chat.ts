import crypto from "crypto";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import {
  getChatMessages,
  createChatMessage,
  getPollsBySession,
  getPollById,
  getPollResponses,
  createPollResponse,
  getTeachingSessionByIdAndSchool,
  getTeachingSessionForStudent,
  getStudentById,
  getChatMessageByIdAndSchool,
  deleteChatMessage,
  getActiveHandsForStudent,
  upsertClasspilotActiveHand,
  clearClasspilotActiveHand,
  getActiveSessionsForStudents,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";
import {
  broadcastToStaffSessionLocal,
  sendToDeviceLocal,
} from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";
import {
  FAB_HAND_TTL_MS,
  FabContractError,
  resolveStudentFabSessions,
  studentDisplayName,
} from "../../services/classpilotFab.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const pollResponseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0"),
  message: { error: "Too many poll responses. Please wait a moment." },
});

function isClasspilotAdmin(req: any, res: any): boolean {
  const role = res.locals.membershipRole as string | undefined;
  return !!req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
}

async function authorizedStaffSession(
  req: any,
  res: any,
  sessionId: string,
  options: { active?: boolean } = {}
) {
  const schoolId = res.locals.schoolId as string;
  const session = await getTeachingSessionByIdAndSchool(sessionId, schoolId);
  if (!session || (options.active && session.endTime)) return null;
  if (isClasspilotAdmin(req, res)) return session;
  return await isAuthorizedClasspilotSessionStaff(schoolId, sessionId, req.authUser!.id)
    ? session
    : null;
}

function retiredDeviceTargeting(res: any, replacement: string) {
  return res.status(410).json({
    error: "This legacy device-targeting endpoint has been retired",
    code: "LEGACY_DEVICE_TARGETING_RETIRED",
    replacement,
  });
}

function handleFabContractError(error: unknown, res: any): boolean {
  if (error instanceof FabContractError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

function publicChatMessage<T extends Record<string, any>>(message: T) {
  const { deviceId: _deviceId, recipientId: _recipientId, ...safe } = message;
  return safe;
}

// ============================================================================
// Chat (Teacher broadcast)
// ============================================================================

// POST /api/classpilot/chat/send - Teacher sends chat message
router.post("/chat/send", ...staffAuth, async (req, res, next) => {
  return retiredDeviceTargeting(res, "/api/classpilot/teacher/reply with sessionId and studentId");
});

// GET /api/classpilot/chat/:sessionId - Get chat messages for session
router.get("/chat/:sessionId", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "sessionId");
    if (!(await authorizedStaffSession(req, res, sessionId))) {
      return res.status(404).json({ error: "Session not found" });
    }
    const messages = await getChatMessages(sessionId, res.locals.schoolId!);
    return res.json({ messages: messages.map(publicChatMessage) });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Student Communication (device JWT auth)
// ============================================================================

// POST /api/classpilot/student/raise-hand
router.post("/student/raise-hand", requireDeviceAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const { student, sessions } = await resolveStudentFabSessions({ schoolId, studentId, feature: "hand" });
    const expiresAt = new Date(Date.now() + FAB_HAND_TTL_MS);
    const raisedHands = [];

    for (const session of sessions) {
      const activeHand = await upsertClasspilotActiveHand({
        schoolId,
        teachingSessionId: session.id,
        studentId,
        deviceId,
        raisedAt: new Date(),
        expiresAt,
        clearedAt: null,
      });
      const payload = {
        type: "hand-raised",
        sessionId: session.id,
        data: {
          sessionId: session.id,
          studentId,
          studentName: studentDisplayName(student),
          studentEmail: (res.locals.studentEmail as string) || student.email || "",
          timestamp: activeHand.raisedAt.toISOString(),
        },
      };
      broadcastToStaffSessionLocal(schoolId, session.id, payload);
      await publishWS({ kind: "staff-session", schoolId, sessionId: session.id }, payload);
      raisedHands.push({ sessionId: session.id, raisedAt: activeHand.raisedAt });
    }

    return res.json({ ok: true, handRaised: true, raisedHands });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// POST /api/classpilot/student/lower-hand
router.post("/student/lower-hand", requireDeviceAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    const activeHands = await getActiveHandsForStudent(schoolId, studentId);

    for (const hand of activeHands) {
      await clearClasspilotActiveHand({
        schoolId,
        teachingSessionId: hand.teachingSessionId,
        studentId,
      });
      const payload = {
        type: "hand-lowered",
        sessionId: hand.teachingSessionId,
        data: { sessionId: hand.teachingSessionId, studentId },
      };
      broadcastToStaffSessionLocal(schoolId, hand.teachingSessionId, payload);
      await publishWS({ kind: "staff-session", schoolId, sessionId: hand.teachingSessionId }, payload);
    }

    return res.json({ ok: true, handRaised: false, clearedSessions: activeHands.map((hand) => hand.teachingSessionId) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/student/send-message
router.post("/student/send-message", requireDeviceAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const { message } = req.body;
    const content = String(message || "").trim();

    if (!content) {
      return res.status(400).json({ error: "message required" });
    }

    const { student, sessions } = await resolveStudentFabSessions({ schoolId, studentId, feature: "chat" });
    const messages = [];

    for (const session of sessions) {
      const msg = await createChatMessage({
        schoolId,
        sessionId: session.id,
        studentId,
        deviceId,
        senderId: studentId,
        senderType: "student",
        recipientId: null,
        content,
        messageType: "message",
        deliveryStatus: "delivered",
        deliveredAt: new Date(),
      });

      const broadcastPayload = {
        type: "student-message",
        sessionId: session.id,
        data: {
          id: msg.id,
          sessionId: session.id,
          studentId,
          studentName: studentDisplayName(student),
          studentEmail: (res.locals.studentEmail as string) || student.email || "",
          message: content,
          messageType: "message",
          timestamp: msg.createdAt.toISOString(),
        },
      };

      broadcastToStaffSessionLocal(schoolId, session.id, broadcastPayload);
      await publishWS({ kind: "staff-session", schoolId, sessionId: session.id }, broadcastPayload);
      messages.push(msg);
    }

    return res.json({
      message: messages[0] ? publicChatMessage(messages[0]) : null,
      messageId: messages[0]?.id,
      messages: messages.map(publicChatMessage),
    });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// ============================================================================
// Teacher Messages & Hands
// ============================================================================

// GET /api/classpilot/teacher/messages - Get student messages
router.get("/teacher/messages", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId query param required" });
    }
    const schoolId = res.locals.schoolId!;
    if (!(await authorizedStaffSession(req, res, sessionId))) {
      return res.status(404).json({ error: "Session not found" });
    }
    const messages = await getChatMessages(sessionId, schoolId);
    return res.json({ messages: messages.map(publicChatMessage) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/reply - Reply to student message
router.post("/teacher/reply", ...staffAuth, async (req, res, next) => {
  try {
    const { sessionId, toStudentId, studentId: bodyStudentId, message } = req.body;
    const targetStudentId = toStudentId || bodyStudentId;
    const schoolId = res.locals.schoolId!;
    const content = String(message || "").trim();

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    if (!targetStudentId) {
      return res.status(400).json({ error: "studentId required" });
    }
    if (!content) {
      return res.status(400).json({ error: "message required" });
    }
    if (!(await authorizedStaffSession(req, res, sessionId, { active: true }))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = await getTeachingSessionForStudent(schoolId, sessionId, targetStudentId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const activeSessions = await getActiveSessionsForStudents(schoolId, [targetStudentId]);
    const targetDeviceId = activeSessions.find((row) => row.studentId === targetStudentId)?.deviceId;

    const msg = await createChatMessage({
      schoolId,
      sessionId: session.id,
      studentId: targetStudentId,
      deviceId: targetDeviceId || null,
      senderId: req.authUser!.id,
      senderType: "teacher",
      recipientId: targetDeviceId || null,
      content,
      messageType: "message",
      deliveryStatus: targetDeviceId ? "sent" : "failed",
      failedAt: targetDeviceId ? null : new Date(),
      errorMessage: targetDeviceId ? null : "No registered student device",
    });

    if (targetDeviceId) {
      const replyPayload = {
        type: "teacher-message",
        _msgId: crypto.randomUUID(),
        chatMessageId: msg.id,
        messageId: msg.id,
        sessionId: session.id,
        studentId: targetStudentId,
        message: content,
        fromName: "Teacher",
      };
      sendToDeviceLocal(schoolId, targetDeviceId, replyPayload);
      await publishWS({ kind: "device", schoolId, deviceId: targetDeviceId }, replyPayload);
    }

    return res.json({ message: publicChatMessage(msg) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/messages/:messageId
router.delete("/teacher/messages/:messageId", ...staffAuth, async (req, res, next) => {
  try {
    const messageId = param(req, "messageId");
    const owned = await getChatMessageByIdAndSchool(messageId, res.locals.schoolId!);
    if (!owned) {
      return res.status(404).json({ error: "Message not found" });
    }
    if (!(await authorizedStaffSession(req, res, owned.sessionId))) {
      return res.status(404).json({ error: "Message not found" });
    }
    await deleteChatMessage(messageId, res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/dismiss-hand/:studentId
router.post("/teacher/dismiss-hand/:studentId", ...staffAuth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const schoolId = res.locals.schoolId!;
    const sessionId = String(req.body?.sessionId || req.query.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    if (!(await authorizedStaffSession(req, res, sessionId, { active: true }))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = await getTeachingSessionForStudent(schoolId, sessionId, studentId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await clearClasspilotActiveHand({ schoolId, teachingSessionId: session.id, studentId });

    // Send to specific student device(s) in remote-control format (service-worker expects this)
    const rcMsg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "hand-dismissed", data: { sessionId: session.id, studentId } },
    };
    const activeSessions = await getActiveSessionsForStudents(schoolId, [studentId]);
    for (const activeSession of activeSessions) {
      sendToDeviceLocal(schoolId, activeSession.deviceId, rcMsg);
      await publishWS({ kind: "device", schoolId, deviceId: activeSession.deviceId }, rcMsg);
    }

    // Teacher notification — top-level for Dashboard WS handler
    const teacherMsg = { type: "hand-dismissed", sessionId: session.id, studentId };
    broadcastToStaffSessionLocal(schoolId, session.id, teacherMsg);
    await publishWS({ kind: "staff-session", schoolId, sessionId: session.id }, teacherMsg);

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/close-chat - Close chat with student
router.post("/teacher/close-chat", ...staffAuth, async (req, res, next) => {
  try {
    const { sessionId, studentId } = req.body;
    const schoolId = res.locals.schoolId!;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId required" });
    }
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }
    if (!(await authorizedStaffSession(req, res, sessionId, { active: true }))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = await getTeachingSessionForStudent(schoolId, sessionId, studentId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const activeSessions = await getActiveSessionsForStudents(schoolId, [studentId]);
    const targetDeviceId = activeSessions.find((row) => row.studentId === studentId)?.deviceId;

    if (targetDeviceId) {
      const payload = { type: "chat-closed", _msgId: crypto.randomUUID(), sessionId: session.id, studentId };
      sendToDeviceLocal(schoolId, targetDeviceId, payload);
      await publishWS({ kind: "device", schoolId, deviceId: targetDeviceId }, payload);
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Polls
// ============================================================================

// POST /api/classpilot/polls/create - Create poll
router.post("/polls/create", ...staffAuth, async (req, res, next) => {
  return retiredDeviceTargeting(res, "/api/classpilot/commands with commandType=poll and student IDs");
});

// GET /api/classpilot/polls - List polls for teacher
router.get("/polls", ...staffAuth, async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId query param required" });
    }
    if (!(await authorizedStaffSession(req, res, sessionId as string))) {
      return res.status(404).json({ error: "Session not found" });
    }
    const polls = await getPollsBySession(sessionId as string);
    return res.json({ polls });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/polls/:pollId/results - Poll results
router.get("/polls/:pollId/results", ...staffAuth, async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const poll = await getPollById(pollId);
    if (!poll) {
      return res.status(404).json({ error: "Poll not found" });
    }
    if (!(await authorizedStaffSession(req, res, poll.sessionId))) {
      return res.status(404).json({ error: "Poll not found" });
    }

    const responses = await getPollResponses(pollId);

    // Aggregate responses by option (matching standalone format)
    const countMap = new Map<number, number>();
    for (const r of responses) {
      countMap.set(r.selectedOption, (countMap.get(r.selectedOption) || 0) + 1);
    }
    const results = Array.from(countMap.entries()).map(([option, count]) => ({ option, count }));

    return res.json({ poll, results, totalResponses: responses.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/polls/:pollId/respond - Student responds to poll
router.post("/polls/:pollId/respond", pollResponseLimiter, requireDeviceAuth, async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const { selectedOption } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;

    if (!Number.isInteger(selectedOption)) {
      return res.status(400).json({ error: "selectedOption must be an integer" });
    }

    const poll = await getPollById(pollId);
    if (!poll || !poll.isActive) {
      return res.status(400).json({ error: "Poll not found or closed" });
    }
    if (selectedOption < 0 || selectedOption >= poll.options.length) {
      return res.status(400).json({ error: "selectedOption is out of range" });
    }
    if (!(await getTeachingSessionForStudent(schoolId, poll.sessionId, studentId))) {
      return res.status(404).json({ error: "Poll not found" });
    }

    const response = await createPollResponse({
      pollId,
      studentId,
      deviceId,
      selectedOption,
    });

    return res.json({ response });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/polls/:pollId/close - Close poll
router.post("/polls/:pollId/close", ...staffAuth, async (req, res, next) => {
  return retiredDeviceTargeting(res, "/api/classpilot/commands with commandType=poll and action=close");
});

// ============================================================================
// Check-ins
// ============================================================================

// POST /api/classpilot/checkin/request - Teacher sends check-in question
router.post("/checkin/request", ...staffAuth, async (req, res, next) => {
  return retiredDeviceTargeting(res, "a future session-scoped student-ID check-in contract");
});

// POST /api/classpilot/checkin/respond - Student responds to check-in (device auth)
router.post("/checkin/respond", requireDeviceAuth, async (req, res, next) => {
  return res.status(410).json({
    error: "The unscoped legacy check-in flow has been retired",
    code: "LEGACY_CHECKIN_RETIRED",
  });
});

export default router;
