import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireGopilotEntitlement } from "../../middleware/requireGopilotEntitlement.js";
import {
  createDismissalChange,
  getEffectiveDismissalType,
  getChangesBySession,
  updateDismissalChange,
  getSessionById,
  getStudentById,
} from "../../services/storage.js";
import { broadcastGoPilot } from "../../realtime/socketio.js";
import {
  canAccessStudent,
  getDismissalChangeForSchool,
  getRequestGoPilotRole,
  getSessionForSchool,
  getTeacherHomeroomIds,
  isGoPilotManager,
} from "../../services/gopilotAccess.js";
import {
  emitDismissalOverrideApplied,
  GoPilotOverrideConflictError,
  reviewDismissalChangeRequest,
} from "../../services/gopilotOverrides.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireGopilotEntitlement,
  requireActiveSchool,
] as const;
const VALID_DISMISSAL_TYPES = new Set(["car", "bus", "walker", "afterschool"]);

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
      if (session.status !== "active") {
        return res.status(409).json({ error: "Dismissal session is not active", code: "GOPILOT_SESSION_NOT_ACTIVE" });
      }
      if (!VALID_DISMISSAL_TYPES.has(fromType) || !VALID_DISMISSAL_TYPES.has(toType) || fromType === toType) {
        return res.status(400).json({ error: "A valid dismissal type transition is required", code: "GOPILOT_INVALID_DISMISSAL_TRANSITION" });
      }
      if (toType === "bus" && !String(busRoute ?? "").trim()) {
        return res.status(400).json({ error: "busRoute is required for bus changes" });
      }
      const role = await getRequestGoPilotRole(req, res);
      if (!(await canAccessStudent(req.authUser!, res.locals.schoolId!, studentId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const student = await getStudentById(studentId);
      if (!student || student.schoolId !== res.locals.schoolId || student.status !== "active") {
        return res.status(404).json({ error: "Student not found" });
      }
      const effectiveType = await getEffectiveDismissalType(studentId, sessionId);
      if (fromType !== effectiveType) {
        return res.status(409).json({
          error: "Student dismissal type changed; refresh before submitting",
          code: "GOPILOT_DISMISSAL_TYPE_CONFLICT",
          currentType: effectiveType,
        });
      }

      const change = await createDismissalChange({
        schoolId: res.locals.schoolId!,
        sessionId,
        studentId,
        requestedBy: req.authUser!.id,
        fromType,
        toType,
        busRoute: busRoute || null,
        note: note || null,
      });

      // Notify office and the student's homeroom teacher
      const payload = {
        change,
        studentName: student ? `${student.firstName} ${student.lastName}` : "",
      };
      const broadcasts = [
        broadcastGoPilot(`school:${res.locals.schoolId}:office`, "change:requested", payload),
      ];
      if (student?.homeroomId) {
        broadcasts.push(
          broadcastGoPilot(
            `school:${res.locals.schoolId}:teacher:${student.homeroomId}`,
            "change:requested",
            payload
          )
        );
      }
      await Promise.all(broadcasts);

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
router.post("/changes/:id/acknowledge", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const existing = await getDismissalChangeForSchool(id, res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Change request not found" });
    }

    const role = await getRequestGoPilotRole(req, res);
    const canAcknowledge = isGoPilotManager(role) ||
      (role === "teacher" && await canAccessStudent(req.authUser!, res.locals.schoolId!, existing.studentId, role));
    if (!canAcknowledge) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const updated = await updateDismissalChange(id, {
      acknowledgedBy: req.authUser!.id,
      acknowledgedAt: new Date(),
    });

    const student = await getStudentById(existing.studentId);
    const payload = {
      change: updated,
      studentName: student ? `${student.firstName} ${student.lastName}` : "",
    };
    const broadcasts = [
      broadcastGoPilot(`school:${res.locals.schoolId}:office`, "change:acknowledged", payload),
    ];
    if (student?.homeroomId) {
      broadcasts.push(
        broadcastGoPilot(
          `school:${res.locals.schoolId}:teacher:${student.homeroomId}`,
          "change:acknowledged",
          payload
        )
      );
    }
    await Promise.all(broadcasts);

    return res.json({ change: updated });
  } catch (err) {
    if (err instanceof GoPilotOverrideConflictError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

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
    if (!isGoPilotManager(role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (status === "approved") {
      const session = await getSessionById(existing.sessionId);
      if (!session || session.status !== "active") {
        return res.status(409).json({ error: "Dismissal session is not active" });
      }
      if (existing.toType === "bus" && !existing.busRoute) {
        return res.status(400).json({ error: "busRoute is required for bus approvals" });
      }
    }

    const reviewed = await reviewDismissalChangeRequest({
      changeId: id,
      schoolId: res.locals.schoolId!,
      status,
      reviewedBy: req.authUser!.id,
      changedByRole: "office",
    });
    if (!reviewed) {
      return res.status(404).json({ error: "Change request not found" });
    }

    if (status === "approved" && reviewed.override) {
      await emitDismissalOverrideApplied({
        schoolId: res.locals.schoolId!,
        sessionId: existing.sessionId,
        student: reviewed.student,
        overrideType: existing.toType,
        busRoute: existing.busRoute,
        reason: existing.note || null,
        changedBy: req.authUser!.id,
        changedByRole: "office",
        override: reviewed.override,
        removedQueueEntries: reviewed.removedQueueEntries,
        queueChanged: reviewed.queueChanged,
      });
    }

    const payload = {
      change: reviewed.change,
      studentName: `${reviewed.student.firstName} ${reviewed.student.lastName}`.trim(),
    };
    const broadcasts = [
      broadcastGoPilot(`school:${res.locals.schoolId}:office`, "change:resolved", payload),
    ];
    if (reviewed.student.homeroomId) {
      broadcasts.push(
        broadcastGoPilot(
          `school:${res.locals.schoolId}:teacher:${reviewed.student.homeroomId}`,
          "change:resolved",
          payload
        )
      );
    }
    await Promise.all(broadcasts);

    return res.json({ change: reviewed.change });
  } catch (err) {
    if (err instanceof GoPilotOverrideConflictError) {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export default router;
