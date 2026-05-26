import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  createDismissalChange,
  getChangesBySession,
  updateDismissalChange,
  updateStudent,
  getSessionById,
  getStudentById,
} from "../../services/storage.js";
import { getIO } from "../../realtime/socketio.js";
import {
  canAccessStudent,
  getDismissalChangeForSchool,
  getRequestGoPilotRole,
  getSessionForSchool,
  getTeacherHomeroomIds,
  isGoPilotManager,
} from "../../services/gopilotAccess.js";

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
      if (!(await canAccessStudent(req.authUser!, res.locals.schoolId!, studentId, await getRequestGoPilotRole(req, res)))) {
        return res.status(403).json({ error: "Insufficient permissions" });
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

      // Notify office and the student's homeroom teacher
      const io = getIO();
      if (io) {
        const student = await getStudentById(studentId);
        const payload = {
          change,
          studentName: student ? `${student.firstName} ${student.lastName}` : "",
        };
        io.to(`school:${res.locals.schoolId}:office`).emit("change:requested", payload);
        if (student?.homeroomId) {
          io.to(`school:${res.locals.schoolId}:teacher:${student.homeroomId}`).emit("change:requested", payload);
        }
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
      const session = await getSessionForSchool(sessionId, res.locals.schoolId!);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const rows = await getChangesBySession(sessionId);
      const role = await getRequestGoPilotRole(req, res);
      const teacherHomerooms = role === "teacher"
        ? await getTeacherHomeroomIds(req.authUser!.id, res.locals.schoolId!)
        : null;

      const changes = rows
        .filter((r) => {
          if (isGoPilotManager(role)) return true;
          if (role === "parent") return r.change.requestedBy === req.authUser!.id;
          if (role === "teacher" && r.student.homeroomId) {
            return teacherHomerooms?.has(r.student.homeroomId);
          }
          return false;
        })
        .map((r) => ({
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
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }

    const existing = await getDismissalChangeForSchool(id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Change request not found" });
    }
    const role = await getRequestGoPilotRole(req, res);
    const canReview = isGoPilotManager(role) ||
      (role === "teacher" && await canAccessStudent(req.authUser!, res.locals.schoolId!, existing.studentId, role));
    if (!canReview) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const updated = await updateDismissalChange(id, {
      status,
      reviewedBy: req.authUser!.id,
      reviewedAt: new Date(),
    });

    // If approved, update student's dismissal type and notify all parties
    if (status === "approved" && existing) {
      await updateStudent(existing.studentId, {
        dismissalType: existing.toType,
        ...(existing.busRoute && { busRoute: existing.busRoute }),
      });

      // Notify teacher/office that student type changed so roster updates
      const io = getIO();
      if (io) {
        const student = await getStudentById(existing.studentId);
        const typePayload = {
          studentId: existing.studentId,
          dismissalType: existing.toType,
          busRoute: existing.busRoute,
        };
        io.to(`school:${res.locals.schoolId}:office`).emit("student:typeUpdated", typePayload);
        if (student?.homeroomId) {
          io.to(`school:${res.locals.schoolId}:teacher:${student.homeroomId}`).emit("student:typeUpdated", typePayload);
        }
        // Notify parent of resolution
        io.to(
          `school:${res.locals.schoolId}:parent:${existing.requestedBy}`
        ).emit("change:resolved", { change: updated });
      }
    } else {
      // Rejected or other status — still notify parent
      const io = getIO();
      if (io) {
        io.to(
          `school:${res.locals.schoolId}:parent:${existing.requestedBy}`
        ).emit("change:resolved", { change: updated });
      }
    }

    return res.json({ change: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
