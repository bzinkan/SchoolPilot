import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import {
  sendMessage,
  confirmAction,
  deleteConversation,
  isChatAvailable,
  type ConversationContext,
} from "../services/chatService.js";

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => req.authUser?.id?.toString() || req.ip,
  message: { error: "Too many messages. Please wait a moment." },
});

const auth = [authenticate, requireSchoolContext] as const;

function buildContext(req: any, res: any): ConversationContext {
  const user = req.authUser!;
  const membership = res.locals.membership;
  return {
    userId: user.id,
    schoolId: res.locals.schoolId!,
    schoolName: membership?.schoolName || "Unknown School",
    userName: user.displayName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Unknown",
    userRole: membership?.role || "teacher",
    licensedProducts: res.locals.licensedProducts || [],
  };
}

// POST /api/chat/message — send a message, get SSE stream back
router.post("/message", ...auth, chatLimiter, async (req, res) => {
  if (!isChatAvailable()) {
    res.status(503).json({ error: "AI chat is not configured" });
    return;
  }

  const { conversationId, message } = req.body;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "Message is required" });
    return;
  }
  if (message.length > 2000) {
    res.status(400).json({ error: "Message too long (max 2000 characters)" });
    return;
  }

  const convId = conversationId || crypto.randomUUID();
  const context = buildContext(req, res);

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Conversation-Id": convId,
  });

  try {
    for await (const event of sendMessage(convId, message.trim(), context)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err: any) {
    console.error("[Chat Route] Stream error:", err);
    res.write(
      `data: ${JSON.stringify({ type: "error", content: "An unexpected error occurred." })}\n\n`
    );
  }

  res.end();
});

// POST /api/chat/confirm — confirm or cancel a pending action
router.post("/confirm", ...auth, async (req, res) => {
  if (!isChatAvailable()) {
    res.status(503).json({ error: "AI chat is not configured" });
    return;
  }

  const { conversationId, confirmed } = req.body;
  if (!conversationId) {
    res.status(400).json({ error: "conversationId is required" });
    return;
  }

  const context = buildContext(req, res);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    for await (const event of confirmAction(
      conversationId,
      !!confirmed,
      context
    )) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err: any) {
    console.error("[Chat Route] Confirm error:", err);
    res.write(
      `data: ${JSON.stringify({ type: "error", content: "An unexpected error occurred." })}\n\n`
    );
  }

  res.end();
});

// DELETE /api/chat/conversations/:id — clear a conversation
router.delete("/conversations/:id", ...auth, (req, res) => {
  deleteConversation(req.params.id as string);
  res.json({ ok: true });
});

// GET /api/chat/status — check if chat is available
router.get("/status", ...auth, (_req, res) => {
  res.json({ available: isChatAvailable() });
});

export default router;
