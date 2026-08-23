import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getGroupTeachers,
  getGroupByIdAndSchool,
  getScheduledClassConflictByIdAndSchool,
  getSchoolById,
  getUserById,
  listActiveScheduledClassConflicts,
  resolveScheduledClassConflict,
} from "../../services/storage.js";
import { isClasspilotStaffUserConnected } from "../../realtime/classpilotStaffPresence.js";
import {
  broadcastScheduledConflictUpdate,
  closeScheduledConflictReporting,
  skipScheduledClassBeforeStart,
  startScheduledClassFromConflict,
} from "../../services/classpilotScheduledStart.js";
import { serializeClasspilotSession } from "../../services/classpilotSessionLifecycle.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function isAdmin(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
}

function displayName(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "Unknown teacher";
}

function payload(conflict: any) {
  const value = conflict.conflictPayload || {};
  return typeof value === "object" && value ? value as any : {};
}

async function affectedTeacherIds(conflict: any): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const group of payload(conflict).monitoredGroups || payload(conflict).groups || []) {
    if (group.teacherId) ids.add(group.teacherId);
    if (group.classId) {
      const teachers = await getGroupTeachers(group.classId);
      teachers.forEach((teacher) => ids.add(teacher.teacherId));
    }
  }
  return ids;
}

async function scheduledClassStaffIds(conflict: any): Promise<Set<string>> {
  const ids = new Set<string>([conflict.teacherId].filter(Boolean));
  const teachers = await getGroupTeachers(conflict.groupId);
  teachers.forEach((teacher) => ids.add(teacher.teacherId));
  return ids;
}

async function viewContext(conflict: any, userId: string, admin: boolean) {
  const affected = await affectedTeacherIds(conflict);
  const scheduledStaff = await scheduledClassStaffIds(conflict);
  if (admin) return { visible: true, audience: "admin", canAct: true };
  if (conflict.teacherId === userId) return { visible: true, audience: "scheduled_teacher", canAct: true };
  if (scheduledStaff.has(userId)) return { visible: true, audience: "scheduled_coteacher", canAct: false };
  if (affected.has(userId)) return { visible: true, audience: "affected_teacher", canAct: false };
  return { visible: false, audience: "none", canAct: false };
}

function conflictMessage(conflict: any, teacherName: string, audience: string, connected: boolean): string {
  const data = payload(conflict);
  const className = data.selectedClass?.name || "Scheduled class";
  const count = data.claimableCount ?? data.totalOverlapCount ?? 0;
  if (audience === "scheduled_teacher") {
    return `${className} started while you were not logged in. Reporting is active, and ${count} student${count === 1 ? "" : "s"} may be waiting under Available until you open ClassPilot.`;
  }
  if (audience === "scheduled_coteacher") {
    return `${className} has started for ${teacherName}, but ${teacherName} is not currently logged in. Reporting is active; this block needs supervision.`;
  }
  if (!connected) {
    if (audience === "affected_teacher") {
      return `${teacherName}'s ${className} has started, but ${teacherName} is not currently logged in. Reporting is active; students remain in your class unless an admin, co-teacher, eligible staff member, or the scheduled teacher picks them up.`;
    }
    return `${className} has started for ${teacherName}, but ${teacherName} is not currently logged in. Reporting is active; this block needs supervision.`;
  }
  return `${className} is waiting for scheduled coverage. ${count} student${count === 1 ? "" : "s"} may be available for temporary pickup.`;
}

async function serializeConflict(conflict: any, context: { audience: string; canAct: boolean }) {
  const teacher = await getUserById(conflict.teacherId);
  const teacherName = displayName(teacher);
  const connected = conflict.scheduledTeacherConnected === true
    || await isClasspilotStaffUserConnected(conflict.schoolId, conflict.teacherId);
  return {
    id: conflict.id,
    schoolId: conflict.schoolId,
    groupId: conflict.groupId,
    teacherId: conflict.teacherId,
    teacherName,
    scheduledDate: conflict.scheduledDate,
    blockStartTime: conflict.blockStartTime,
    blockEndTime: conflict.blockEndTime,
    status: conflict.status,
    scheduledTeacherConnected: connected,
    audience: context.audience,
    canStartAnyway: context.canAct,
    // Once a conflict exists the scheduled occurrence has already started;
    // End Class, not Skip Today, is the only terminal action.
    canSkip: false,
    message: conflictMessage(conflict, teacherName, context.audience, connected),
    overlap: payload(conflict),
    lastCheckedAt: conflict.lastCheckedAt,
    createdAt: conflict.createdAt,
  };
}

function broadcastConflictUpdate(schoolId: string, conflictId: string) {
  broadcastScheduledConflictUpdate(schoolId, conflictId);
}

function expiredScheduledConflictResponse(res: any) {
  return res.status(409).json({
    code: "SCHEDULED_CONFLICT_EXPIRED",
    status: "expired",
    error: "This scheduled block has ended. Students will move with the next class or become available again.",
  });
}

router.get("/scheduled-conflicts", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const admin = isAdmin(req, res);
    const rows = await listActiveScheduledClassConflicts(schoolId);
    const visible = [];
    for (const conflict of rows) {
      const context = await viewContext(conflict, req.authUser!.id, admin);
      if (context.visible) visible.push(await serializeConflict(conflict, context));
    }
    return res.json({ conflicts: visible });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/scheduled-classes/:groupId/skip-today
// This is intentionally group/date based because a conflict does not exist
// until the occurrence has begun, at which point skipping is no longer valid.
router.post("/scheduled-classes/:groupId/skip-today", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const group = await getGroupByIdAndSchool(param(req, "groupId"), schoolId);
    if (!group || !group.scheduleEnabled || !group.blockStartTime || !group.blockEndTime) {
      return res.status(404).json({ error: "Scheduled class not found" });
    }
    if (!isAdmin(req, res) && group.teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Only an admin or the scheduled teacher can skip this class" });
    }
    const school = await getSchoolById(schoolId);
    const timeZone = school?.schoolTimezone || "America/New_York";
    const now = new Date();
    const scheduledDate = now.toLocaleDateString("en-CA", { timeZone });
    const result = await skipScheduledClassBeforeStart({ group, scheduledDate, now });
    if (!result.skipped) {
      if (result.reason === "school_date_changed") {
        return res.status(409).json({
          skipped: false,
          reason: "school_date_changed",
          code: "SCHEDULE_DATE_CHANGED_RETRY",
          error: "The school date changed while this request was processing. Try Skip Today again.",
        });
      }
      if (result.reason === "non_instructional_day") {
        return res.json({
          skipped: false,
          reason: "non_instructional_day",
          code: "NON_INSTRUCTIONAL_DAY",
          message: "This date is already non-instructional. No scheduled occurrence was created.",
        });
      }
      return res.status(409).json({
        code: "SCHEDULED_OCCURRENCE_ALREADY_STARTED",
        error: "This scheduled class has already started. Use End Class to finalize it and send its Session Summary.",
      });
    }
    return res.json({
      skipped: true,
      occurrence: result.session ? serializeClasspilotSession(result.session) : null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/scheduled-conflicts/:id/start-anyway", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const conflict = await getScheduledClassConflictByIdAndSchool(param(req, "id"), schoolId);
    if (!conflict) return res.status(404).json({ error: "Scheduled coverage request not found" });
    if (conflict.status === "expired") return expiredScheduledConflictResponse(res);
    if (!["coverage_needed", "claimed", "pending"].includes(conflict.status)) return res.status(404).json({ error: "Scheduled coverage request not found" });
    if (!isAdmin(req, res) && conflict.teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Only an admin or the scheduled teacher can start this class" });
    }
    const session = await startScheduledClassFromConflict({ conflict, actorId: req.authUser!.id });
    return res.status(201).json({ session: serializeClasspilotSession(session) });
  } catch (err) {
    if ((err as any)?.code === "SCHEDULED_CONFLICT_EXPIRED") return expiredScheduledConflictResponse(res);
    if ((err as any)?.code === "SCHEDULED_CONFLICT_NOT_ACTIVE") {
      return res.status(409).json({
        code: "SCHEDULED_CONFLICT_NOT_ACTIVE",
        error: (err as Error).message,
      });
    }
    next(err);
  }
});

router.post("/scheduled-conflicts/:id/skip", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const conflict = await getScheduledClassConflictByIdAndSchool(param(req, "id"), schoolId);
    if (!conflict || !["coverage_needed", "claimed", "pending"].includes(conflict.status)) return res.status(404).json({ error: "Scheduled coverage request not found" });
    if (!isAdmin(req, res) && conflict.teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Only an admin or the scheduled teacher can skip this class" });
    }
    const group = await getGroupByIdAndSchool(conflict.groupId, schoolId);
    if (!group) return res.status(404).json({ error: "Scheduled class not found" });
    const skipped = await skipScheduledClassBeforeStart({
      group,
      scheduledDate: conflict.scheduledDate,
    });
    if (!skipped.skipped) {
      if (skipped.reason === "school_date_changed") {
        return res.status(409).json({
          skipped: false,
          reason: "school_date_changed",
          code: "SCHEDULE_DATE_CHANGED_RETRY",
          error: "The school date changed while this request was processing. Try again.",
        });
      }
      if (skipped.reason === "non_instructional_day") {
        return res.json({
          skipped: false,
          reason: "non_instructional_day",
          code: "NON_INSTRUCTIONAL_DAY",
          message: "This date is already non-instructional. No scheduled occurrence was created.",
        });
      }
      return res.status(409).json({
        code: "SCHEDULED_OCCURRENCE_ALREADY_STARTED",
        error: "This scheduled class has already started. Use End Class to finalize it and send its Session Summary.",
      });
    }
    await closeScheduledConflictReporting({
      conflict,
      releaseReason: "scheduled_skipped",
    });
    const updated = await resolveScheduledClassConflict(conflict.id, schoolId, "skipped", req.authUser!.id);
    broadcastConflictUpdate(schoolId, conflict.id);
    return res.json({ conflict: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
