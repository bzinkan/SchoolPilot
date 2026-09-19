import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { redisStore } from "../../middleware/rateLimiter.js";
import { STUDENT_CHAT_COOLDOWN, studentChatRetryAfterMs } from "../../services/classpilotChatChannelControl.js";
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
  markAuthorizedClasspilotStudentMessagesRead,
  classpilotTeacherChatAckRejection,
  listAuthorizedClasspilotStudentChatTranscript,
  getStudentById,
  withClasspilotStudentControlDeliveryAuthority,
  withClasspilotSupervisionTelemetryAuthority,
  getClasspilotStudentControlState,
} from "../../services/storage.js";
import {
  broadcastToStaffSessionLocal,
  sendToDeviceLocal,
  sendToStudentBindingLocal,
} from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";
import { reportStudentChatFanOut } from "../../services/classpilotChatDelivery.js";
import {
  FAB_HAND_TTL_MS,
  FabContractError,
  studentDisplayName,
} from "../../services/classpilotFab.js";
import { assertClasspilotEntitled } from "../../services/classpilotEntitlement.js";
import { classpilotCommandAuthorityEnvelope } from "../../services/classpilotCommandAuthority.js";
import {
  chatTranscriptWindow,
  decodeChatTranscriptCursor,
  encodeChatTranscriptCursor,
  parseClasspilotClientMessageId,
  parseClasspilotTeachingSessionId,
  parseTeacherChatAckStatus,
} from "../../services/classpilotStudentChat.js";
import { logAudit, logAuditStrict } from "../../services/audit.js";
import { readActivityHistoryScope } from "../../services/classpilotActivityHistory.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { requireScheduledClassroomContext, parseClasspilotActivityAuthority, requireScheduledClassroomRequestRevision } from "../../services/classpilotActivityAuthority.js";
import { createScheduledStudentMessage, mutateScheduledStudentHand, createScheduledTeacherReply,
  publishScheduledClassroomEvent, authorizeScheduledTeacherStudentAction, type ScheduledStudentAction } from "../../services/classpilotScheduledClassroomTools.js";
import { db } from "../../db.js";
import { and, eq, isNull } from "drizzle-orm";
import { chatMessages, classpilotActiveHands, polls as pollsTable } from "../../schema/classpilot.js";

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

/** Every per-student limiter in this file keys on the authenticated student session. */
export const studentSessionRateLimitKey = pollResponseRateLimitKey;

const pollResponseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: pollResponseRateLimitKey,
  message: { error: "Too many poll responses. Please wait a moment." },
});

// Student chat cooldown: a short burst window catches a mashed Enter key, a
// longer one catches a running commentary. Redis-backed so the count is the
// same on every task; the device reads retryAfterMs and waits instead of
// retrying into the same window.
function studentChatCooldownLimiter(prefix: string, limit: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: limit.windowMs,
    max: limit.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: studentSessionRateLimitKey,
    store: redisStore(prefix),
    passOnStoreError: true,
    handler: (req: Request, res: Response) => {
      const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
      const retryAfterMs = studentChatRetryAfterMs(info?.resetTime, limit.windowMs);
      res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment.", code: "CHAT_COOLDOWN", retryAfterMs });
    },
  });
}
const studentChatBurstLimiter = studentChatCooldownLimiter("rl:classpilot-chat-burst:", STUDENT_CHAT_COOLDOWN.burst);
const studentChatSustainedLimiter = studentChatCooldownLimiter("rl:classpilot-chat-sustained:", STUDENT_CHAT_COOLDOWN.sustained);

function isClasspilotAdmin(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
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
    const pauseReason = (error as any).pauseReason;
    res.status((error as any).status).json({
      error: error.message,
      code: (error as any).code,
      ...(typeof pauseReason === "string" ? { pauseReason } : {}),
    });
    return true;
  }
  return false;
}

function publicChatMessage<T extends Record<string, any>>(message: T) {
  const {
    deviceId: _deviceId,
    studentSessionId: _studentSessionId,
    recipientId: _recipientId,
    ...safe
  } = message;
  return safe;
}

function scheduledStudentAction(req: any, res: any): ScheduledStudentAction {
  const authority = parseClasspilotActivityAuthority(req.body);
  if (!authority?.supervisionContextId || req.body.sessionId) throw Object.assign(new Error("Exactly one classroom authority is required"), { status: 400, expose: true, code: "ACTIVITY_AUTHORITY_INVALID" });
  return { schoolId: res.locals.schoolId, supervisionContextId: authority.supervisionContextId, studentId: res.locals.studentId,
    studentSessionId: res.locals.studentSessionId, deviceId: res.locals.deviceId, studentControlRevision: req.body.studentControlRevision };
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
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const options = scheduledStudentAction(req, res);
      const { context, hand } = await mutateScheduledStudentHand({ ...options, raised: true });
      await publishScheduledClassroomEvent(context, { type: "hand-raised", data: { supervisionContextId: context.id,
        studentId: options.studentId, timestamp: hand!.raisedAt.toISOString() } });
      return res.json({ ok: true, handRaised: true, raisedHands: [{ supervisionContextId: context.id, raisedAt: hand!.raisedAt }] });
    }
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
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const options = scheduledStudentAction(req, res);
      const { context } = await mutateScheduledStudentHand({ ...options, raised: false });
      await publishScheduledClassroomEvent(context, { type: "hand-lowered", data: { supervisionContextId: context.id, studentId: options.studentId } });
      return res.json({ ok: true, handRaised: false, clearedContexts: [{ supervisionContextId: context.id }] });
    }
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
router.post("/student/send-message", requireDeviceAuth, studentChatBurstLimiter, studentChatSustainedLimiter, requireClasspilotEntitlement, async (req, res, next) => {
  try {
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const options = scheduledStudentAction(req, res);
      const result = await createScheduledStudentMessage({ ...options, content: String(req.body.message || "").trim(), clientMessageId: String(req.body.clientMessageId || "") });
      const message = publicChatMessage(result.message);
      if (result.created) {
        const fanOut = await publishScheduledClassroomEvent(result.context, { type: "student-message", data: message });
        reportStudentChatFanOut({ schoolId: result.context.schoolId, authority: { kind: "supervision-context", id: result.context.id },
          messageId: message.id, source: "local", ...fanOut });
      }
      return res.json({ message, messageId: message.id, clientMessageId: message.clientMessageId, supervisionContextId: result.context.id,
        delivered: true, duplicate: !result.created, messages: [message] });
    }
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const deviceId = res.locals.deviceId as string;
    const {
      message,
      clientMessageId: rawClientMessageId,
      sessionId: rawTeachingSessionId,
    } = req.body;
    const content = String(message || "").trim();
    const parsedClientMessageId = parseClasspilotClientMessageId(rawClientMessageId);
    const parsedTeachingSessionId = parseClasspilotTeachingSessionId(rawTeachingSessionId);

    if (!content) {
      return res.status(400).json({ error: "message required" });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: "message cannot exceed 500 characters", code: "MESSAGE_TOO_LONG" });
    }
    if (parsedClientMessageId.status === "invalid") {
      return res.status(400).json({ error: "clientMessageId must be a UUID", code: "CLIENT_MESSAGE_ID_INVALID" });
    }
    if (parsedTeachingSessionId.status === "invalid") {
      return res.status(400).json({ error: "sessionId must be a UUID", code: "TEACHING_SESSION_ID_INVALID" });
    }
    const clientMessageId = parsedClientMessageId.clientMessageId;
    const teachingSessionId = parsedTeachingSessionId.teachingSessionId;

    const { student, teachingSession, message: msg, created } = await createAuthorizedClasspilotStudentMessage({
      schoolId,
      studentId,
      studentSessionId,
      deviceId,
      content,
      clientMessageId,
      teachingSessionId,
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
    if (created) {
      const delivered = broadcastToStaffSessionLocal(schoolId, teachingSession.id, broadcastPayload);
      const relayAccepted = await publishWS({ kind: "staff-session", schoolId, sessionId: teachingSession.id }, broadcastPayload);
      reportStudentChatFanOut({ schoolId, authority: { kind: "teaching-session", id: teachingSession.id },
        messageId: msg.id, source: "local", delivered, relayAccepted });
    }

    return res.json({
      message: publicChatMessage(msg),
      messageId: msg.id,
      clientMessageId: msg.clientMessageId,
      sessionId: teachingSession.id,
      delivered: true,
      duplicate: !created,
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
      const status = parseTeacherChatAckStatus(raw?.deliveryStatus ?? raw?.status);
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
        studentControlRevision: raw?.studentControlRevision,
        errorMessage: typeof (raw?.errorMessage ?? raw?.error) === "string"
          ? String(raw.errorMessage ?? raw.error).slice(0, 500)
          : null,
      });
      receipts.push(acknowledged
        ? { ackId, messageId, accepted: true }
        : { ackId, messageId, accepted: false, code: await classpilotTeacherChatAckRejection({ schoolId, chatMessageId: messageId, studentId }) });
      if (acknowledged?.message.sessionId) {
        const payload = {
          type: "chat-message-delivery",
          sessionId: acknowledged.message.sessionId,
          messageId,
          studentId,
          deliveryStatus: acknowledged.message.deliveryStatus,
          seenAt: acknowledged.message.seenAt,
          errorMessage: acknowledged.message.errorMessage,
        };
        broadcastToStaffSessionLocal(schoolId, acknowledged.message.sessionId, payload);
        await publishWS({ kind: "staff-session", schoolId, sessionId: acknowledged.message.sessionId }, payload);
      } else if (acknowledged?.message.supervisionContextId) {
        const context = await requireScheduledClassroomContext({ schoolId, supervisionContextId: acknowledged.message.supervisionContextId });
        await publishScheduledClassroomEvent(context, { type: "chat-message-delivery", messageId, studentId,
          deliveryStatus: acknowledged.message.deliveryStatus, seenAt: acknowledged.message.seenAt, errorMessage: acknowledged.message.errorMessage });
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
    if ("supervisionContextId" in req.query && (!parseClasspilotActivityAuthority(req.query) || req.query.sessionId)) {
      return res.status(400).json({ error: "Exactly one classroom authority is required" });
    }
    if (typeof req.query.supervisionContextId === "string") {
      const context = await requireScheduledClassroomContext({ schoolId: res.locals.schoolId!, supervisionContextId: req.query.supervisionContextId,
        actorId: req.authUser!.id, allowObserve: isClasspilotAdmin(req, res) });
      const messages = await db.select().from(chatMessages).where(and(eq(chatMessages.schoolId, context.schoolId), eq(chatMessages.supervisionContextId, context.id),
        isNull(chatMessages.deletedAt))).orderBy(chatMessages.createdAt).limit(500);
      return res.json({ messages: messages.map(publicChatMessage) });
    }
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

// POST /api/classpilot/teacher/messages/read - Teacher-side read state.
// Observe is read-only: an admin watching a class never marks a teacher's
// inbox read, and students are never told about read state.
router.post("/teacher/messages/read", ...staffAuth, async (req, res, next) => {
  try {
    const rawIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : null;
    if (!rawIds || rawIds.length < 1 || rawIds.length > 200
      || rawIds.some((id: unknown) => typeof id !== "string" || !id.trim() || id.length > 128)) {
      return res.status(400).json({ error: "messageIds must contain between 1 and 200 message ids", code: "INVALID_MESSAGE_IDS" });
    }
    const messageIds: string[] = rawIds.map((id: string) => id.trim());
    const schoolId = res.locals.schoolId!;
    const actorId = req.authUser!.id;
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const authority = parseClasspilotActivityAuthority(req.body);
      if (!authority?.supervisionContextId || req.body.sessionId) return res.status(400).json({ error: "Exactly one classroom authority is required" });
      const context = await requireScheduledClassroomContext({ schoolId, supervisionContextId: authority.supervisionContextId, actorId });
      const result = await markAuthorizedClasspilotStudentMessagesRead({ schoolId, actorId, messageIds, authority: { supervisionContextId: context.id } });
      if (result.updatedIds.length > 0) {
        await publishScheduledClassroomEvent(context, { type: "chat-messages-read", messageIds: result.updatedIds,
          readAt: result.readAt.toISOString(), readBy: actorId });
      }
      return res.json({ readAt: result.readAt.toISOString(), updatedIds: result.updatedIds });
    }
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!(await authorizedStaffSession(req, res, sessionId, { mutate: true }))) {
      return res.status(404).json({ error: "Session not found" });
    }
    const result = await markAuthorizedClasspilotStudentMessagesRead({ schoolId, actorId, messageIds, authority: { sessionId } });
    if (result.updatedIds.length > 0) {
      const payload = { type: "chat-messages-read", sessionId, messageIds: result.updatedIds, readAt: result.readAt.toISOString(), readBy: actorId };
      broadcastToStaffSessionLocal(schoolId, sessionId, payload);
      await publishWS({ kind: "staff-session", schoolId, sessionId }, payload);
    }
    return res.json({ readAt: result.readAt.toISOString(), updatedIds: result.updatedIds });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/reply - Reply to student message
router.post("/teacher/reply", ...staffAuth, async (req, res, next) => {
  try {
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const authority = parseClasspilotActivityAuthority(req.body);
      if (!authority?.supervisionContextId || req.body.sessionId) return res.status(400).json({ error: "Exactly one classroom authority is required" });
      const result = await createScheduledTeacherReply({ schoolId: res.locals.schoolId!, contextId: authority.supervisionContextId,
        contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")),
        actorId: req.authUser!.id, studentId: String(req.body.studentId || req.body.toStudentId || ""), content: String(req.body.message || "").trim() });
      const binding = (await getActiveSessionsForStudents(result.context.schoolId, [result.message.studentId!]))[0];
      if (binding) {
        const target = { kind: "student-binding" as const, schoolId: result.context.schoolId, studentId: result.message.studentId!,
          studentSessionId: binding.id, deviceId: binding.deviceId };
        const delivery = await withClasspilotStudentControlDeliveryAuthority({ ...target, claimTeacherChatDeliveries: true, limit: 20 },
          (database) => getClasspilotStudentControlState(target.schoolId, target.studentId, database),
          (claimed, control) => claimed.map(({ message }) => {
            const payload = { type: "teacher-message", _msgId: message.id, chatMessageId: message.id, messageId: message.id,
              supervisionContextId: message.supervisionContextId, studentId: target.studentId, studentSessionId: binding.id,
              studentControlRevision: control?.revision, message: message.content, fromName: "Teacher" };
            sendToStudentBindingLocal(target, payload);
            return publishWS(target, payload);
          }));
        if (delivery.authorized) await Promise.all(delivery.value);
      }
      await publishScheduledClassroomEvent(result.context, { type: "teacher-message", data: publicChatMessage(result.message) });
      return res.status(201).json({ message: publicChatMessage(result.message), queued: true });
    }
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

    if (targetBinding) {
      const exactTarget = {
        kind: "student-binding" as const,
        schoolId,
        studentId: targetStudentId,
        studentSessionId: targetBinding.id,
        deviceId: targetBinding.deviceId,
      };
      const immediateDelivery = await withClasspilotStudentControlDeliveryAuthority(
        {
          ...exactTarget,
          claimTeacherChatDeliveries: true,
          limit: 20,
        },
        () => undefined,
        (claimed) => claimed.map(({ message: claimedMessage }) => {
          const replyPayload = {
            type: "teacher-message",
            _msgId: claimedMessage.id,
            chatMessageId: claimedMessage.id,
            messageId: claimedMessage.id,
            sessionId: claimedMessage.sessionId,
            studentId: targetStudentId,
            studentSessionId: targetBinding.id,
            message: claimedMessage.content,
            fromName: "Teacher",
          };
          sendToStudentBindingLocal(exactTarget, replyPayload);
          // A delayed cross-process publish is safe because every receiving
          // task revalidates this durable exact binding before local fan-out.
          return publishWS(exactTarget, replyPayload);
        })
      );
      if (immediateDelivery.authorized) {
        await Promise.all(immediateDelivery.value);
      }
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
    const deleted = await deleteAuthorizedClasspilotChatMessage({
      schoolId: res.locals.schoolId!,
      messageId,
      actorId: req.authUser!.id,
      contextAuthorityRevision: req.get("X-ClassPilot-Context-Authority-Revision"),
    });
    // A removal must leave a trail; the row itself stays for the transcript. Never the content.
    await logAuditStrict({
      schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole,
      action: "classpilot.chat.message_deleted", entityType: "chat_message", entityId: messageId,
      metadata: { studentId: deleted.studentId, senderType: deleted.senderType, sessionId: deleted.sessionId, supervisionContextId: deleted.supervisionContextId },
    });
    return res.json({ ok: true });
  } catch (err) {
    if (handleFabContractError(err, res)) return;
    next(err);
  }
});

// GET /api/classpilot/students/:studentId/messages - Read-only transcript.
// Staff read the class or supervision context they actually hold (admins may
// observe one); an unscoped read is admin-only and capped at 90 days. Every
// read is audited without content.
router.get("/students/:studentId/messages", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const studentId = param(req, "studentId");
    const admin = isClasspilotAdmin(req, res);
    const scopeRequested = "teachingSessionId" in req.query || "supervisionContextId" in req.query || "sessionId" in req.query;
    const authority = scopeRequested ? parseClasspilotActivityAuthority(req.query) : null;
    if (scopeRequested && !authority) return res.status(400).json({ error: "Exactly one classroom authority is required" });
    if (!authority && !admin) {
      return res.status(403).json({ error: "A classroom authority is required to read messages", code: "CHAT_TRANSCRIPT_SCOPE_REQUIRED" });
    }
    const limitValue = Number(req.query.limit);
    const limit = Number.isSafeInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 200) : 100;
    const cursor = req.query.cursor === undefined ? null : decodeChatTranscriptCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) return res.status(400).json({ error: "Invalid transcript cursor", code: "CHAT_TRANSCRIPT_CURSOR_INVALID" });
    const parseDate = (value: unknown) => {
      if (value === undefined || value === null || value === "") return null;
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? undefined : date;
    };
    const requestedFrom = parseDate(req.query.from), requestedTo = parseDate(req.query.to);
    if (requestedFrom === undefined || requestedTo === undefined) return res.status(400).json({ error: "from and to must be dates" });
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) return res.status(404).json({ error: "Student not found", code: "student_not_found" });
    const scopeOptions = authority ? {
      schoolId, staffId: req.authUser!.id, studentId, authority,
      contextAuthorityRevision: authority.supervisionContextId
        ? requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")) : undefined,
      allowObserve: admin,
    } : null;
    const historyScope = scopeOptions ? await readActivityHistoryScope(scopeOptions) : null;
    if (scopeOptions && !historyScope) {
      return res.status(403).json({ error: "Classroom activity is no longer available", code: "CHAT_TRANSCRIPT_UNAVAILABLE" });
    }
    const window = chatTranscriptWindow({ requestedFrom, requestedTo, scope: historyScope });
    const includeDeleted = admin && req.query.includeDeleted === "true";
    const page = await listAuthorizedClasspilotStudentChatTranscript({
      schoolId, studentId, authority, from: window.from, to: window.to, limit, cursor,
      anchorMessageId: typeof req.query.anchorMessageId === "string" ? req.query.anchorMessageId.slice(0, 128) : null,
      includeDeleted,
    });
    if (scopeOptions && historyScope) {
      const latest = await readActivityHistoryScope(scopeOptions);
      if (!latest || latest.stamp !== historyScope.stamp) return res.status(409).json({ error: "Classroom activity changed; refresh history", code: "CHAT_TRANSCRIPT_SCOPE_CHANGED" });
    }
    await logAudit({
      schoolId, userId: req.authUser!.id, userRole: res.locals.membershipRole,
      action: "classpilot.chat.transcript_read", entityType: "student", entityId: studentId,
      metadata: { teachingSessionId: authority?.teachingSessionId ?? null, supervisionContextId: authority?.supervisionContextId ?? null,
        from: window.from.toISOString(), to: window.to.toISOString(), count: page.messages.length, includeDeleted },
    });
    return res.json({
      student: { id: student.id, firstName: student.firstName, lastName: student.lastName },
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      messages: page.messages.map(publicChatMessage),
      nextCursor: page.nextCursor ? encodeChatTranscriptCursor(page.nextCursor) : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/dismiss-hand/:studentId
router.post("/teacher/dismiss-hand/:studentId", ...staffAuth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const schoolId = res.locals.schoolId!;
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const authority = parseClasspilotActivityAuthority(req.body);
      if (!authority?.supervisionContextId || req.body.sessionId || req.query.sessionId) return res.status(400).json({ error: "Exactly one classroom authority is required" });
      const result = await authorizeScheduledTeacherStudentAction({ schoolId, contextId: authority.supervisionContextId,
        contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")),
        actorId: req.authUser!.id, studentId, dismissHand: true });
      if (result.binding) {
        const binding = result.binding;
        await withClasspilotSupervisionTelemetryAuthority({ schoolId, supervisionContextId: result.context.id, studentId,
          studentSessionId: binding.id, deviceId: binding.deviceId, controlRevision: result.controlRevision,
          scheduledClassroomOnly: true, actorId: req.authUser!.id }, async () => {
            const target = { kind: "student-binding" as const, schoolId, studentId, studentSessionId: binding.id, deviceId: binding.deviceId };
            const payload = { type: "remote-control", _msgId: crypto.randomUUID(), studentId, studentSessionId: binding.id,
              command: { type: "hand-dismissed", studentId, studentSessionId: binding.id,
                ...classpilotCommandAuthorityEnvelope({ supervisionContextId: result.context.id }),
                studentControlRevision: result.controlRevision, data: { supervisionContextId: result.context.id, studentId, studentSessionId: binding.id } } };
            sendToStudentBindingLocal(target, payload); await publishWS(target, payload);
          });
      }
      await publishScheduledClassroomEvent(result.context, { type: "hand-dismissed", studentId });
      return res.json({ ok: true });
    }
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
    if (req.body.supervisionContextId !== undefined && req.body.supervisionContextId !== null) {
      const authority = parseClasspilotActivityAuthority(req.body);
      if (!authority?.supervisionContextId || sessionId) return res.status(400).json({ error: "Exactly one classroom authority is required" });
      const result = await authorizeScheduledTeacherStudentAction({ schoolId, contextId: authority.supervisionContextId,
        contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")),
        actorId: req.authUser!.id, studentId: String(studentId || "") });
      if (result.binding) {
        const binding = result.binding;
        await withClasspilotSupervisionTelemetryAuthority({ schoolId, supervisionContextId: result.context.id, studentId,
          studentSessionId: binding.id, deviceId: binding.deviceId, controlRevision: result.controlRevision,
          scheduledClassroomOnly: true, actorId: req.authUser!.id }, async () => {
            const target = { kind: "student-binding" as const, schoolId, studentId, studentSessionId: binding.id, deviceId: binding.deviceId };
            const payload = { type: "chat-closed", _msgId: crypto.randomUUID(), studentId, studentSessionId: binding.id,
              ...classpilotCommandAuthorityEnvelope({ supervisionContextId: result.context.id }), studentControlRevision: result.controlRevision };
            sendToStudentBindingLocal(target, payload); await publishWS(target, payload);
          });
      }
      await logAudit({ schoolId, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.chat.closed",
        entityType: "student", entityId: String(studentId || ""), metadata: { supervisionContextId: result.context.id } });
      return res.json({ ok: true });
    }

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

    await logAudit({ schoolId, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.chat.closed",
      entityType: "student", entityId: String(studentId), metadata: { teachingSessionId: teachingSession.id } });
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
    if ("supervisionContextId" in req.query && (!parseClasspilotActivityAuthority(req.query) || req.query.sessionId)) {
      return res.status(400).json({ error: "Exactly one classroom authority is required" });
    }
    if (typeof req.query.supervisionContextId === "string") {
      const context = await requireScheduledClassroomContext({ schoolId: res.locals.schoolId!, supervisionContextId: req.query.supervisionContextId,
        actorId: req.authUser!.id, allowObserve: isClasspilotAdmin(req, res) });
      const rows = await db.select().from(pollsTable).where(and(eq(pollsTable.schoolId, context.schoolId), eq(pollsTable.supervisionContextId, context.id))).orderBy(pollsTable.createdAt).limit(100);
      return res.json({ polls: rows });
    }
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
    if (poll.supervisionContextId) await requireScheduledClassroomContext({ schoolId: res.locals.schoolId!, supervisionContextId: poll.supervisionContextId,
      actorId: req.authUser!.id, allowObserve: isClasspilotAdmin(req, res) });
    if (!poll.supervisionContextId && (!poll.sessionId || !(await authorizedStaffSession(req, res, poll.sessionId)))) {
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
    if (req.body.supervisionContextId != null && (!parseClasspilotActivityAuthority(req.body) || req.body.sessionId)) {
      return res.status(400).json({ error: "Exactly one classroom authority is required" });
    }
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
      supervisionContextId: typeof req.body.supervisionContextId === "string" ? req.body.supervisionContextId : undefined,
      studentControlRevision: req.body.studentControlRevision,
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
