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
} from "../../services/storage.js";

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

export default router;
