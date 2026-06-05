import crypto from "crypto";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import {
  getChatMessages,
  createChatMessage,
  getPollsBySession,
  getPollById,
  createPoll,
  closePoll,
  getPollResponses,
  createPollResponse,
  getMessagesBySchool,
  createMessage,
  deleteMessage,
  getMessageByIdAndSchool,
  createCheckIn,
  getActiveTeachingSession,
  getTeachingSessionById,
  getStudentById,
  getStudentDevices,
  getGroupById,
} from "../../services/storage.js";
import {
  broadcastToTeachersLocal,
  broadcastToStudentsLocal,
  sendToDeviceLocal,
} from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

const pollResponseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0"),
  message: { error: "Too many poll responses. Please wait a moment." },
});

async function sessionBelongsToSchool(sessionId: string, schoolId: string): Promise<boolean> {
  // Sessionless / synthetic ids are namespaced with the school id prefix.
  if (sessionId.startsWith(`${schoolId}-`)) {
    return true;
  }
  const session = await getTeachingSessionById(sessionId);
  if (!session) {
    return false;
  }
  const group = await getGroupById(session.groupId);
  return group?.schoolId === schoolId;
}

async function pollBelongsToSchool(poll: { sessionId: string }, schoolId: string): Promise<boolean> {
  return sessionBelongsToSchool(poll.sessionId, schoolId);
}

// ============================================================================
// Chat (Teacher broadcast)
// ============================================================================

// POST /api/classpilot/chat/send - Teacher sends chat message
router.post("/chat/send", ...staffAuth, async (req, res, next) => {
  try {
    const { sessionId, content, recipientId } = req.body;
    if (!sessionId || !content) {
      return res.status(400).json({ error: "sessionId and content required" });
    }
    if (!(await sessionBelongsToSchool(sessionId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const msg = await createChatMessage({
      sessionId,
      senderId: req.authUser!.id,
      senderType: "teacher",
      recipientId: recipientId || null,
      content,
      messageType: "message",
    });

    const schoolId = res.locals.schoolId!;
    const chatMsg = { type: "chat", message: msg };

    if (recipientId) {
      sendToDeviceLocal(schoolId, recipientId, chatMsg);
      await publishWS({ kind: "device", schoolId, deviceId: recipientId }, chatMsg);
    } else {
      broadcastToStudentsLocal(schoolId, chatMsg);
      await publishWS({ kind: "students", schoolId }, chatMsg);
    }

    return res.json({ message: msg });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/chat/:sessionId - Get chat messages for session
router.get("/chat/:sessionId", ...staffAuth, async (req, res, next) => {
  try {
    const sessionId = param(req, "sessionId");
    if (!(await sessionBelongsToSchool(sessionId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Session not found" });
    }
    const messages = await getChatMessages(sessionId);
    return res.json({ messages });
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
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const msg = {
      type: "hand-raised",
      data: {
        studentId,
        studentName: student ? `${student.firstName} ${student.lastName}` : studentId,
        studentEmail: (res.locals.studentEmail as string) || student?.email || "",
        timestamp: new Date().toISOString(),
      },
    };
    broadcastToTeachersLocal(schoolId, msg);
    await publishWS({ kind: "staff", schoolId }, msg);

    return res.json({ ok: true });
  } catch (err) {
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

    const msg = { type: "hand-lowered", data: { studentId } };
    broadcastToTeachersLocal(schoolId, msg);
    await publishWS({ kind: "staff", schoolId }, msg);

    return res.json({ ok: true });
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

    if (!message) {
      return res.status(400).json({ error: "message required" });
    }

    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const msg = await createMessage({
      fromUserId: null,
      toStudentId: studentId,
      message,
      isAnnouncement: false,
    });

    const broadcastPayload = {
      type: "student-message",
      data: {
        id: msg.id,
        studentId,
        studentName: student ? `${student.firstName} ${student.lastName}` : studentId,
        studentEmail: (res.locals.studentEmail as string) || student?.email || "",
        deviceId,
        message,
        messageType: "message",
        timestamp: new Date().toISOString(),
      },
    };

    broadcastToTeachersLocal(schoolId, broadcastPayload);
    await publishWS({ kind: "staff", schoolId }, broadcastPayload);

    return res.json({ message: msg });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher Messages & Hands
// ============================================================================

// GET /api/classpilot/teacher/messages - Get student messages
router.get("/teacher/messages", ...staffAuth, async (req, res, next) => {
  try {
    const messages = await getMessagesBySchool(res.locals.schoolId!);
    return res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/reply - Reply to student message
router.post("/teacher/reply", ...staffAuth, async (req, res, next) => {
  try {
    const { toStudentId, studentId: bodyStudentId, message, deviceId: bodyDeviceId } = req.body;
    const targetStudentId = toStudentId || bodyStudentId;

    if (!message) {
      return res.status(400).json({ error: "message required" });
    }

    if (targetStudentId) {
      const student = await getStudentById(targetStudentId);
      if (!student || student.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }
    }

    const msg = await createMessage({
      fromUserId: req.authUser!.id,
      toStudentId: targetStudentId || null,
      message,
      isAnnouncement: false,
    });

    // Look up deviceId if not provided
    let targetDeviceId: string | undefined = bodyDeviceId;
    if (!targetDeviceId && targetStudentId) {
      const devices = await getStudentDevices(targetStudentId);
      const firstDevice = devices[0];
      if (firstDevice) targetDeviceId = firstDevice.deviceId;
    }

    if (targetDeviceId) {
      const schoolId = res.locals.schoolId!;
      const replyPayload = { type: "teacher-message", _msgId: crypto.randomUUID(), message: message, fromName: "Teacher" };
      sendToDeviceLocal(schoolId, targetDeviceId, replyPayload);
      await publishWS({ kind: "device", schoolId, deviceId: targetDeviceId }, replyPayload);
    }

    return res.json({ message: msg });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/messages/:messageId
router.delete("/teacher/messages/:messageId", ...staffAuth, async (req, res, next) => {
  try {
    const messageId = param(req, "messageId");
    const owned = await getMessageByIdAndSchool(messageId, res.locals.schoolId!);
    if (!owned) {
      return res.status(404).json({ error: "Message not found" });
    }
    await deleteMessage(messageId);
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

    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Send to specific student device(s) in remote-control format (service-worker expects this)
    const rcMsg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "hand-dismissed", data: { studentId } },
    };
    const devices = await getStudentDevices(studentId);
    for (const d of devices) {
      sendToDeviceLocal(schoolId, d.deviceId, rcMsg);
      await publishWS({ kind: "device", schoolId, deviceId: d.deviceId }, rcMsg);
    }

    // Teacher notification — top-level for Dashboard WS handler
    const teacherMsg = { type: "hand-dismissed", studentId };
    broadcastToTeachersLocal(schoolId, teacherMsg);
    await publishWS({ kind: "staff", schoolId }, teacherMsg);

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/close-chat - Close chat with student
router.post("/teacher/close-chat", ...staffAuth, async (req, res, next) => {
  try {
    const { studentId, deviceId: bodyDeviceId } = req.body;
    const schoolId = res.locals.schoolId!;

    if (studentId) {
      const student = await getStudentById(studentId);
      if (!student || student.schoolId !== schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }
    }

    let targetDeviceId = bodyDeviceId;
    if (!targetDeviceId && studentId) {
      const devices = await getStudentDevices(studentId);
      const firstDevice = devices[0];
      if (firstDevice) targetDeviceId = firstDevice.deviceId;
    }

    if (targetDeviceId) {
      const payload = { type: "chat-closed", _msgId: crypto.randomUUID() };
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
  try {
    const { question, options, targetDeviceIds } = req.body;
    if (!question || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: "Question and at least 2 options are required" });
    }

    const teacherId = req.authUser!.id;
    const schoolId = res.locals.schoolId!;

    // Get active teaching session (or use a synthetic session ID). Guard against
    // a multi-school teacher whose active session belongs to a different school —
    // fall back to the school-namespaced synthetic id rather than tagging the poll
    // with (and broadcasting under) a foreign school's session.
    const activeSession = await getActiveTeachingSession(teacherId);
    const sessionId =
      activeSession && (await sessionBelongsToSchool(activeSession.id, schoolId))
        ? activeSession.id
        : `${schoolId}-${teacherId}`;

    const poll = await createPoll({
      sessionId,
      teacherId,
      question,
      options,
    });

    // Broadcast poll to students using remote-control format
    const message = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: {
        type: "poll",
        data: { action: "start", pollId: poll.id, question, options },
      },
    };

    let sentTo = 0;
    if (Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
      for (const deviceId of targetDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        sentTo++;
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds }, message);
    } else {
      sentTo = broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.status(201).json({ success: true, poll, sentTo });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/polls - List polls for teacher
router.get("/polls", ...staffAuth, async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId query param required" });
    }
    if (!(await sessionBelongsToSchool(sessionId as string, res.locals.schoolId!))) {
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
    if (!(await pollBelongsToSchool(poll, res.locals.schoolId!))) {
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
    if (!(await pollBelongsToSchool(poll, schoolId))) {
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
  try {
    const pollId = param(req, "pollId");
    const { targetDeviceIds } = req.body;
    const schoolId = res.locals.schoolId!;

    const existing = await getPollById(pollId);
    if (!existing || !(await pollBelongsToSchool(existing, schoolId))) {
      return res.status(404).json({ error: "Poll not found" });
    }

    const poll = await closePoll(pollId);
    if (!poll) {
      return res.status(404).json({ error: "Poll not found" });
    }

    // Broadcast close command to students
    const message = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: {
        type: "poll",
        data: { action: "close", pollId },
      },
    };

    let sentTo = 0;
    if (Array.isArray(targetDeviceIds) && targetDeviceIds.length > 0) {
      for (const deviceId of targetDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        sentTo++;
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds }, message);
    } else {
      sentTo = broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.json({ success: true, poll, sentTo });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Check-ins
// ============================================================================

// POST /api/classpilot/checkin/request - Teacher sends check-in question
router.post("/checkin/request", ...staffAuth, async (req, res, next) => {
  try {
    const { question, options } = req.body;
    const schoolId = res.locals.schoolId!;

    const msg = {
      type: "checkin-request",
      question: question || "How are you feeling?",
      options: options || ["happy", "neutral", "sad", "stressed"],
      timestamp: new Date().toISOString(),
    };

    broadcastToStudentsLocal(schoolId, msg);
    await publishWS({ kind: "students", schoolId }, msg);

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/checkin/respond - Student responds to check-in (device auth)
router.post("/checkin/respond", requireDeviceAuth, async (req, res, next) => {
  try {
    const studentId = res.locals.studentId as string;
    const schoolId = res.locals.schoolId as string;
    const { mood, message } = req.body;

    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const checkIn = await createCheckIn({
      studentId,
      mood: mood || "neutral",
      message: message || null,
    });

    broadcastToTeachersLocal(schoolId, {
      type: "checkin-response",
      studentId,
      checkIn,
    });
    await publishWS({ kind: "staff", schoolId }, {
      type: "checkin-response",
      studentId,
      checkIn,
    });

    return res.json({ checkIn });
  } catch (err) {
    next(err);
  }
});

export default router;
