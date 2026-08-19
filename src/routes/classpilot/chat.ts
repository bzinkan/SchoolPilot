import crypto from "crypto";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getChatMessages,
  createAuthorizedClasspilotStudentMessage,
  raiseAuthorizedClasspilotStudentHand,
  lowerAuthorizedClasspilotStudentHand,
  createTeacherChatReplyWithDelivery,
  markTeacherChatDeliveryAttempt,
  acknowledgeTeacherChatDelivery,
  getPollsBySession,
  getPollById,
  getPollResponses,
  createPollResponseFirstWrite,
  getTeachingSessionByIdAndSchool,
  getTeachingSessionForStudent,
  deleteAuthorizedClasspilotChatMessage,
  dismissAuthorizedClasspilotStudentHand,
  authorizeClasspilotTeacherCloseChat,
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
  studentDisplayName,
} from "../../services/classpilotFab.js";
import { assertClasspilotEntitled } from "../../services/classpilotEntitlement.js";
import { classpilotCommandAuthorityEnvelope } from "../../services/classpilotCommandAuthority.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const studentAuth = [requireDeviceAuth, requireClasspilotEntitlement] as const;

export function pollResponseRateLimitKey(req: any, res: any): string {
  const schoolId = String(res?.locals?.schoolId || "").trim();
  const studentSessionId = String(res?.locals?.studentSessionId || "").trim();
  if (schoolId && studentSessionId) return `school:${schoolId}:student-session:${studentSessionId}`;
  return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || "0.0.0.0")}`;
}

const pollResponseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: pollResponseRateLimitKey,
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
  options: { active?: boolean; mutate?: boolean } = {}
) {
  const schoolId = res.locals.schoolId as string;
  const session = await getTeachingSessionByIdAndSchool(sessionId, schoolId);
  if (!session || (options.active && session.endTime)) return null;
  // Admin/super-admin may observe classroom history, but Observe is read-only.
  // Every chat/FAB mutation requires immutable session staff authority.
  if (!options.mutate && isClasspilotAdmin(req, res)) return session;
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
  if (
    error instanceof Error
    && (error as any).expose === true
    && Number.isInteger((error as any).status)
    && typeof (error as any).code === "string"
  ) {
    res.status((error as any).status).json({ error: error.message, code: (error as any).code });
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
router.post("/student/raise-hand", ...studentAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const deviceId = res.locals.deviceId as string;
    const expiresAt = new Date(Date.now() + FAB_HAND_TTL_MS);
    const { student, teachingSession, hand } = await raiseAuthorizedClasspilotStudentHand({
      schoolId,
      studentId,
      studentSessionId,
      deviceId,
      expiresAt,
    });
    const payload = {
      type: "hand-raised",
      sessionId: teachingSession.id,
      data: {
        sessionId: teachingSession.id,
        studentId,
        studentName: studentDisplayName(student),
        studentEmail: (res.locals.studentEmail as string) || student.email || "",
        timestamp: hand.raisedAt.toISOString(),
      },
    };
    broadcastToStaffSessionLocal(schoolId, teachingSession.id, payload);
    await publishWS({ kind: "staff-session", schoolId, sessionId: teachingSession.id }, payload);

    return res.json({
      ok: true,
      handRaised: true,
      raisedHands: [{ sessionId: teachingSession.id, raisedAt: hand.raisedAt }],
    });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// POST /api/classpilot/student/lower-hand
router.post("/student/lower-hand", ...studentAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const { teachingSession } = await lowerAuthorizedClasspilotStudentHand({
      schoolId,
      studentId,
      studentSessionId: res.locals.studentSessionId as string,
      deviceId: res.locals.deviceId as string,
    });
    const payload = {
      type: "hand-lowered",
      sessionId: teachingSession.id,
      data: { sessionId: teachingSession.id, studentId },
    };
    broadcastToStaffSessionLocal(schoolId, teachingSession.id, payload);
    await publishWS({ kind: "staff-session", schoolId, sessionId: teachingSession.id }, payload);

    return res.json({ ok: true, handRaised: false, clearedSessions: [teachingSession.id] });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// POST /api/classpilot/student/send-message
router.post("/student/send-message", ...studentAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const deviceId = res.locals.deviceId as string;
    const { message } = req.body;
    const content = String(message || "").trim();

    if (!content) {
      return res.status(400).json({ error: "message required" });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: "message cannot exceed 500 characters", code: "MESSAGE_TOO_LONG" });
    }

    const { student, teachingSession, message: msg } = await createAuthorizedClasspilotStudentMessage({
      schoolId,
      studentId,
      studentSessionId,
      deviceId,
      content,
    });
    const broadcastPayload = {
      type: "student-message",
      sessionId: teachingSession.id,
      data: {
        id: msg.id,
        sessionId: teachingSession.id,
        studentId,
        studentName: studentDisplayName(student),
        studentEmail: (res.locals.studentEmail as string) || student.email || "",
        message: content,
        messageType: "message",
        timestamp: msg.createdAt.toISOString(),
      },
    };
    broadcastToStaffSessionLocal(schoolId, teachingSession.id, broadcastPayload);
    await publishWS({ kind: "staff-session", schoolId, sessionId: teachingSession.id }, broadcastPayload);

    return res.json({
      message: publicChatMessage(msg),
      messageId: msg.id,
      messages: [publicChatMessage(msg)],
    });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// POST /api/classpilot/device/chat-acks - Durable HTTP fallback for extension ACK outbox
router.post("/device/chat-acks", ...studentAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const deviceId = res.locals.deviceId as string;
    await assertClasspilotEntitled(schoolId);
    const acks = Array.isArray(req.body?.acks) ? req.body.acks : null;
    if (!acks || acks.length < 1 || acks.length > 50) {
      return res.status(400).json({ error: "acks must contain between 1 and 50 items", code: "INVALID_CHAT_ACK_BATCH" });
    }
    const receipts = [];
    for (const raw of acks) {
      const ackId = typeof raw?.ackId === "string" ? raw.ackId.trim().slice(0, 128) : "";
      const messageId = typeof raw?.messageId === "string"
        ? raw.messageId.trim().slice(0, 128)
        : typeof raw?.chatMessageId === "string"
          ? raw.chatMessageId.trim().slice(0, 128)
          : "";
      const rawStatus = raw?.deliveryStatus ?? raw?.status;
      const status = rawStatus === "failed" ? "failed" as const
        : rawStatus === "delivered" ? "delivered" as const
        : null;
      if (!ackId || !messageId || !status) {
        receipts.push({ ackId, messageId, accepted: false, code: "INVALID_CHAT_ACK" });
        continue;
      }
      const acknowledged = await acknowledgeTeacherChatDelivery({
        schoolId,
        chatMessageId: messageId,
        studentId,
        studentSessionId,
        deviceId,
        status,
        errorMessage: typeof (raw?.errorMessage ?? raw?.error) === "string"
          ? String(raw.errorMessage ?? raw.error).slice(0, 500)
          : null,
      });
      receipts.push({ ackId, messageId, accepted: !!acknowledged });
      if (acknowledged?.message.sessionId) {
        const payload = {
          type: "chat-message-delivery",
          sessionId: acknowledged.message.sessionId,
          messageId,
          studentId,
          deliveryStatus: acknowledged.message.deliveryStatus,
          errorMessage: acknowledged.message.errorMessage,
        };
        broadcastToStaffSessionLocal(schoolId, acknowledged.message.sessionId, payload);
        await publishWS({ kind: "staff-session", schoolId, sessionId: acknowledged.message.sessionId }, payload);
      }
    }
    return res.json({ receipts });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code });
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
    if (content.length > 500) {
      return res.status(400).json({ error: "message cannot exceed 500 characters", code: "MESSAGE_TOO_LONG" });
    }
    if (!(await authorizedStaffSession(req, res, sessionId, { active: true, mutate: true }))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = await getTeachingSessionForStudent(schoolId, sessionId, targetStudentId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const { message: msg } = await createTeacherChatReplyWithDelivery({
      schoolId,
      teachingSessionId: session.id,
      studentId: targetStudentId,
      teacherId: req.authUser!.id,
      content,
    });
    const activeSessions = await getActiveSessionsForStudents(schoolId, [targetStudentId]);
    const targetBinding = activeSessions.find((row) => row.studentId === targetStudentId);

    if (targetBinding && await markTeacherChatDeliveryAttempt({
      schoolId,
      chatMessageId: msg.id,
      studentId: targetStudentId,
      studentSessionId: targetBinding.id,
      deviceId: targetBinding.deviceId,
    })) {
      const replyPayload = {
        type: "teacher-message",
        _msgId: msg.id,
        chatMessageId: msg.id,
        messageId: msg.id,
        sessionId: session.id,
        studentId: targetStudentId,
        studentSessionId: targetBinding.id,
        message: content,
        fromName: "Teacher",
      };
      sendToDeviceLocal(schoolId, targetBinding.deviceId, replyPayload);
      await publishWS({ kind: "device", schoolId, deviceId: targetBinding.deviceId }, replyPayload);
    }

    return res.status(202).json({ message: publicChatMessage(msg), queued: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/messages/:messageId
router.delete("/teacher/messages/:messageId", ...staffAuth, async (req, res, next) => {
  try {
    const messageId = param(req, "messageId");
    await deleteAuthorizedClasspilotChatMessage({
      schoolId: res.locals.schoolId!,
      messageId,
      actorId: req.authUser!.id,
    });
    return res.json({ ok: true });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
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
    const { teachingSession, binding } = await dismissAuthorizedClasspilotStudentHand({
      schoolId,
      teachingSessionId: sessionId,
      studentId,
      actorId: req.authUser!.id,
    });

    // Send to specific student device(s) in remote-control format (service-worker expects this)
    if (binding) {
      const rcMsg = {
        type: "remote-control",
        _msgId: crypto.randomUUID(),
        studentId,
        studentSessionId: binding.id,
        command: {
          type: "hand-dismissed",
          studentId,
          studentSessionId: binding.id,
          ...classpilotCommandAuthorityEnvelope({
            teachingSessionId: teachingSession.id,
            supervisionContextId: null,
          }),
          data: { sessionId: teachingSession.id, studentId, studentSessionId: binding.id },
        },
      };
      sendToDeviceLocal(schoolId, binding.deviceId, rcMsg);
      await publishWS({ kind: "device", schoolId, deviceId: binding.deviceId }, rcMsg);
    }

    // Teacher notification — top-level for Dashboard WS handler
    const teacherMsg = { type: "hand-dismissed", sessionId: teachingSession.id, studentId };
    broadcastToStaffSessionLocal(schoolId, teachingSession.id, teacherMsg);
    await publishWS({ kind: "staff-session", schoolId, sessionId: teachingSession.id }, teacherMsg);

    return res.json({ ok: true });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
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
    const { teachingSession, binding } = await authorizeClasspilotTeacherCloseChat({
      schoolId,
      teachingSessionId: sessionId,
      studentId,
      actorId: req.authUser!.id,
    });

    if (binding) {
      const payload = {
        type: "chat-closed",
        _msgId: crypto.randomUUID(),
        sessionId: teachingSession.id,
        studentId,
        studentSessionId: binding.id,
        ...classpilotCommandAuthorityEnvelope({
          teachingSessionId: teachingSession.id,
          supervisionContextId: null,
        }),
      };
      sendToDeviceLocal(schoolId, binding.deviceId, payload);
      await publishWS({ kind: "device", schoolId, deviceId: binding.deviceId }, payload);
    }

    return res.json({ ok: true });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
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
    const polls = await getPollsBySession(res.locals.schoolId!, sessionId as string);
    return res.json({ polls });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/polls/:pollId/results - Poll results
router.get("/polls/:pollId/results", ...staffAuth, async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const poll = await getPollById(pollId, res.locals.schoolId!);
    if (!poll) {
      return res.status(404).json({ error: "Poll not found" });
    }
    if (!(await authorizedStaffSession(req, res, poll.sessionId))) {
      return res.status(404).json({ error: "Poll not found" });
    }

    const responses = await getPollResponses(res.locals.schoolId!, pollId);

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
router.post("/polls/:pollId/respond", requireDeviceAuth, pollResponseLimiter, requireClasspilotEntitlement, async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const { selectedOption } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;

    await assertClasspilotEntitled(schoolId);

    if (!Number.isInteger(selectedOption)) {
      return res.status(400).json({ error: "selectedOption must be an integer" });
    }

    const result = await createPollResponseFirstWrite({
      schoolId,
      pollId,
      studentId,
      studentSessionId: res.locals.studentSessionId as string,
      deviceId,
      selectedOption,
    });
    const { deviceId: _deviceId, ...response } = result.response;
    if (result.disposition === "conflict") {
      return res.status(409).json({
        error: "This poll already has a different answer",
        code: "POLL_ALREADY_ANSWERED",
        response,
      });
    }
    return res.status(result.disposition === "created" ? 201 : 200).json({
      response,
      replayed: result.disposition === "replayed",
    });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
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
router.post("/checkin/respond", ...studentAuth, async (req, res, next) => {
  return res.status(410).json({
    error: "The unscoped legacy check-in flow has been retired",
    code: "LEGACY_CHECKIN_RETIRED",
  });
});

export default router;
