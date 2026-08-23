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
import { runWithoutTenantContext } from "../db/tenantContext.js";
import { activeEntitledProducts } from "../services/productEntitlement.js";

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
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    ...headers,
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");
}

async function releaseRequestTenantContext(res: any): Promise<void> {
  const release = res.locals.releaseTenantContext;
  if (typeof release === "function") await release();
}

async function streamWithDeadline(
  req: any,
  res: any,
  stream: (signal: AbortSignal) => AsyncGenerator<unknown>
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    await runWithoutTenantContext(async () => {
      for await (const event of stream(controller.signal)) {
        if (controller.signal.aborted || res.writableEnded) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abort);
    res.off("close", abort);
  }
}

async function buildContext(req: any, res: any): Promise<ConversationContext> {
  const user = req.authUser!;
  const schoolId = res.locals.schoolId!;
  const userRole = res.locals.membershipRole || req.session?.role || "teacher";

  // Look up active product licenses for this school
  const licenses = await getProductLicenses(schoolId);
  const licensedProducts = activeEntitledProducts({
    school: res.locals.school,
    licenses,
  });

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
  await releaseRequestTenantContext(res);

  // Start SSE immediately so ALB TargetResponseTime does not include model
  // generation time before the first assistant token arrives.
  startSse(res, { "X-Conversation-Id": convId });

  try {
    await streamWithDeadline(
      req,
      res,
      (signal) => sendMessage(convId, message.trim(), context, { signal })
    );
  } catch {
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
  await releaseRequestTenantContext(res);

  startSse(res);

  try {
    await streamWithDeadline(
      req,
      res,
      (signal) => confirmAction(conversationId, !!confirmed, context, { signal })
    );
  } catch {
    res.write(
      `data: ${JSON.stringify({ type: "error", content: "An unexpected error occurred." })}\n\n`
    );
  }

  res.end();
});

// DELETE /api/chat/conversations/:id — clear a conversation
router.delete("/conversations/:id", ...auth, (req, res) => {
  buildContext(req, res)
    .then(async (context) => {
      const deleted = await deleteConversation(req.params.id as string, context);
      res.json({ ok: deleted });
    })
    .catch(() => {
      res.status(500).json({ error: "Failed to delete conversation" });
    });
});

// GET /api/chat/status — check if chat is available
router.get("/status", ...auth, (_req, res) => {
  res.json({ available: isChatAvailable() });
});

export default router;
