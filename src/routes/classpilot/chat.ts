import crypto from "crypto";
import { Router } from "express";
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
  getMessages,
  createMessage,
  deleteMessage,
  createCheckIn,
  getActiveTeachingSession,
  getStudentById,
  getStudentDevices,
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
    const messages = await getChatMessages(param(req, "sessionId"));
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
    const messages = await getMessages({});
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
    await deleteMessage(param(req, "messageId"));
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

    // Get active teaching session (or use a synthetic session ID)
    const activeSession = await getActiveTeachingSession(teacherId);
    const sessionId = activeSession?.id || `${schoolId}-${teacherId}`;

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
    const polls = await getPollsBySession(sessionId as string);
    return res.json({ polls });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/polls/:pollId/results - Poll results
router.get("/polls/:pollId/results", async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const poll = await getPollById(pollId);
    if (!poll) {
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
router.post("/polls/:pollId/respond", async (req, res, next) => {
  try {
    const pollId = param(req, "pollId");
    const { studentId, deviceId, selectedOption } = req.body;

    const poll = await getPollById(pollId);
    if (!poll || !poll.isActive) {
      return res.status(400).json({ error: "Poll not found or closed" });
    }

    const response = await createPollResponse({
      pollId,
      studentId: studentId || "anonymous",
      deviceId: deviceId || null,
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
