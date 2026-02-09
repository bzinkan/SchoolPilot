import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  createDismissalChange,
  getChangesBySession,
  getDismissalChangeById,
  updateDismissalChange,
  updateStudent,
  getSessionById,
} from "../../services/storage.js";
import { getIO } from "../../realtime/socketio.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

// POST /api/gopilot/sessions/:sessionId/changes - Submit change request
router.post(
  "/sessions/:sessionId/changes",
  ...auth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "sessionId");
      const { studentId, fromType, toType, busRoute, note } = req.body;

      if (!studentId || !fromType || !toType) {
        return res
          .status(400)
          .json({ error: "studentId, fromType, and toType are required" });
      }

      const session = await getSessionById(sessionId);
      if (!session || session.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Session not found" });
      }

      const change = await createDismissalChange({
        sessionId,
        studentId,
        requestedBy: req.authUser!.id,
        fromType,
        toType,
        busRoute: busRoute || null,
        note: note || null,
      });

      // Notify office
      const io = getIO();
      if (io) {
        io.to(`school:${res.locals.schoolId}:office`).emit(
          "change:requested",
          { change }
        );
      }

      return res.status(201).json({ change });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/gopilot/sessions/:sessionId/changes - List changes
router.get(
  "/sessions/:sessionId/changes",
  ...auth,
  async (req, res, next) => {
    try {
      const sessionId = param(req, "sessionId");
      const rows = await getChangesBySession(sessionId);

      const changes = rows.map((r) => ({
        ...r.change,
        student: {
          id: r.student.id,
          firstName: r.student.firstName,
          lastName: r.student.lastName,
        },
        requester: {
          id: r.requester.id,
          firstName: r.requester.firstName,
          lastName: r.requester.lastName,
          name: `${r.requester.firstName} ${r.requester.lastName}`,
        },
      }));

      return res.json({ changes });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/gopilot/changes/:id - Approve/reject change
router.put("/changes/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { status } = req.body;

    const existing = await getDismissalChangeById(id);
    if (!existing) {
      return res.status(404).json({ error: "Change request not found" });
    }

    const updated = await updateDismissalChange(id, {
      status,
      reviewedBy: req.authUser!.id,
      reviewedAt: new Date(),
    });

    // If approved, update student's dismissal type
    if (status === "approved" && existing) {
      await updateStudent(existing.studentId, {
        dismissalType: existing.toType,
        ...(existing.busRoute && { busRoute: existing.busRoute }),
      });
    }

    // Notify parent
    const io = getIO();
    if (io) {
      io.to(
        `school:${res.locals.schoolId}:parent:${existing.requestedBy}`
      ).emit("change:resolved", { change: updated });
    }

    return res.json({ change: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
