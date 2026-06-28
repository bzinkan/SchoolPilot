import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getGroupTeachers,
  getScheduledClassConflictByIdAndSchool,
  getUserById,
  listActiveScheduledClassConflicts,
  resolveScheduledClassConflict,
  setScheduleSkippedDate,
} from "../../services/storage.js";
import { broadcastToTeachersLocal, isStaffUserConnectedLocal } from "../../realtime/ws-broadcast.js";
import { startScheduledClassFromConflict } from "../../services/classpilotScheduledStart.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function isAdmin(req: any, res: any): boolean {
  const role = res.locals.membershipRole;
  return !!req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
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

async function viewContext(conflict: any, userId: string, admin: boolean) {
  const affected = await affectedTeacherIds(conflict);
  if (admin) return { visible: true, audience: "admin", canAct: true };
  if (conflict.teacherId === userId) return { visible: true, audience: "scheduled_teacher", canAct: true };
  if (affected.has(userId)) return { visible: true, audience: "affected_teacher", canAct: false };
  return { visible: false, audience: "none", canAct: false };
}

function conflictMessage(conflict: any, teacherName: string, audience: string): string {
  const data = payload(conflict);
  const className = data.selectedClass?.name || "Scheduled class";
  const count = data.claimableCount ?? data.totalOverlapCount ?? 0;
  const connected = conflict.scheduledTeacherConnected === true || isStaffUserConnectedLocal(conflict.schoolId, conflict.teacherId);
  if (audience === "scheduled_teacher") {
    return `${className} was scheduled to start while you were not logged in. ${count} student${count === 1 ? "" : "s"} may be waiting under Available until you start the class.`;
  }
  if (!connected) {
    if (audience === "affected_teacher") {
      return `${teacherName}'s ${className} was scheduled to start, but ${teacherName} is not currently logged in. Students remain in your class unless an admin, eligible staff member, or the scheduled teacher picks them up.`;
    }
    return `${className} was scheduled to start for ${teacherName}, but ${teacherName} is not currently logged in. ClassPilot pushed available online students into Scheduled Coverage Needed instead of creating an unattended class.`;
  }
  return `${className} is waiting for scheduled coverage. ${count} student${count === 1 ? "" : "s"} may be available for temporary pickup.`;
}

async function serializeConflict(conflict: any, context: { audience: string; canAct: boolean }) {
  const teacher = await getUserById(conflict.teacherId);
  const teacherName = displayName(teacher);
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
    scheduledTeacherConnected: conflict.scheduledTeacherConnected === true || isStaffUserConnectedLocal(conflict.schoolId, conflict.teacherId),
    audience: context.audience,
    canStartAnyway: context.canAct,
    canSkip: context.canAct,
    message: conflictMessage(conflict, teacherName, context.audience),
    overlap: payload(conflict),
    lastCheckedAt: conflict.lastCheckedAt,
    createdAt: conflict.createdAt,
  };
}

function broadcastConflictUpdate(schoolId: string, conflictId: string) {
  broadcastToTeachersLocal(schoolId, {
    type: "scheduled-class-conflict-updated",
    conflictId,
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

router.post("/scheduled-conflicts/:id/start-anyway", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const conflict = await getScheduledClassConflictByIdAndSchool(param(req, "id"), schoolId);
    if (!conflict || !["coverage_needed", "claimed", "pending"].includes(conflict.status)) return res.status(404).json({ error: "Scheduled coverage request not found" });
    if (!isAdmin(req, res) && conflict.teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Only an admin or the scheduled teacher can start this class" });
    }
    const session = await startScheduledClassFromConflict({ conflict, actorId: req.authUser!.id });
    return res.status(201).json({ session });
  } catch (err) {
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
    await setScheduleSkippedDate(conflict.groupId, conflict.scheduledDate);
    const updated = await resolveScheduledClassConflict(conflict.id, schoolId, "skipped", req.authUser!.id);
    broadcastConflictUpdate(schoolId, conflict.id);
    return res.json({ conflict: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
