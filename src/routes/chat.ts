import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import {
  sendMessage,
  confirmAction,
  deleteConversation,
  isChatAvailable,
  type ConversationContext,
} from "../services/chatService.js";
import { getProductLicenses } from "../services/storage.js";

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req: any) =>
    req.authUser?.id?.toString() || ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0"),
  message: { error: "Too many messages. Please wait a moment." },
});

const auth = [authenticate, requireSchoolContext] as const;

function startSse(res: any, headers: Record<string, string> = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...headers,
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");
}

async function buildContext(req: any, res: any): Promise<ConversationContext> {
  const user = req.authUser!;
  const schoolId = res.locals.schoolId!;
  const userRole = res.locals.membershipRole || req.session?.role || "teacher";

  // Look up active product licenses for this school
  const licenses = await getProductLicenses(schoolId);
  const licensedProducts = licenses
    .filter((l: any) => l.status === "active")
    .map((l: any) => l.product);

  return {
    userId: user.id,
    schoolId,
    // SOC 2 privacy hardening: do not send school/user identity into the model
    // context unless a future privacy review explicitly approves that data flow.
    schoolName: "current school",
    userName: "current user",
    userRole,
    licensedProducts,
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
  const context = await buildContext(req, res);
  console.log(`[AI Chat] User=${context.userName} Role=${context.userRole} Products=${context.licensedProducts.join(",") || "NONE"}`);

  // Start SSE immediately so ALB TargetResponseTime does not include model
  // generation time before the first assistant token arrives.
  startSse(res, { "X-Conversation-Id": convId });

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

  const context = await buildContext(req, res);

  startSse(res);

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
  buildContext(req, res)
    .then((context) => {
      const deleted = deleteConversation(req.params.id as string, context);
      res.json({ ok: deleted });
    })
    .catch((err) => {
      console.error("[Chat Route] Delete conversation error:", err);
      res.status(500).json({ error: "Failed to delete conversation" });
    });
});

// GET /api/chat/status — check if chat is available
router.get("/status", ...auth, (_req, res) => {
  res.json({ available: isChatAvailable() });
});

export default router;
