import { Router, type Request, type Response } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getActiveClasspilotClassroomStates,
  getActiveClassOwnersForStudents,
  getActiveSessionByStudent,
  getActiveSupervisionForStudents,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupTeachers,
  getRecentClasspilotCommands,
  getSubgroupByIdAndSchool,
  getSubgroupMembers,
  getTeachingSessionByIdAndSchool,
} from "../../services/storage.js";
import {
  commandSummary,
  executeClasspilotCommand,
  normalizeStudentIds,
  resultMessage,
  type ResolvedClasspilotCommandTarget,
} from "../../services/classpilotCommandDispatcher.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

type ClassroomTargetScope = "class" | "subgroup" | "students";

function normalizeTargetScope(value: unknown): ClassroomTargetScope | null {
  if (value === "class" || value === "subgroup" || value === "students") return value;
  return null;
}

async function resolveTargets(req: Request, res: Response, body: any): Promise<ResolvedClasspilotCommandTarget[]> {
  const schoolId = res.locals.schoolId as string;
  const userId = req.authUser!.id;
  const role = res.locals.membershipRole as string | undefined;
  const isAdmin = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
  const teachingSessionId = String(body.teachingSessionId || "").trim();
  if (!teachingSessionId) throw Object.assign(new Error("teachingSessionId is required"), { status: 400 });

  const session = await getTeachingSessionByIdAndSchool(teachingSessionId, schoolId);
  if (!session || session.endTime) throw Object.assign(new Error("Active class session not found"), { status: 404 });
  if (!isAdmin && session.teacherId !== userId) {
    const coTeachers = await getGroupTeachers(session.groupId);
    if (!coTeachers.some((teacher) => teacher.teacherId === userId)) {
      throw Object.assign(new Error("This class session is not assigned to you"), { status: 403 });
    }
  }

  const group = await getGroupByIdAndSchool(session.groupId, schoolId);
  if (!group) throw Object.assign(new Error("Active class group not found"), { status: 404 });

  const scope = normalizeTargetScope(body.targetScope);
  if (!scope) throw Object.assign(new Error("targetScope must be class, subgroup, or students"), { status: 400 });

  const classRows = await getGroupStudents(group.id);
  const classStudentIds = new Set(classRows.map((row) => row.studentId));
  if (classRows.length === 0) throw Object.assign(new Error("The active class has no students"), { status: 400 });

  let selectedRows = classRows;
  if (scope === "students") {
    const targetStudentIds = normalizeStudentIds(body.targetStudentIds);
    if (targetStudentIds.length === 0) {
      throw Object.assign(new Error("targetStudentIds is required when targetScope is students"), { status: 400 });
    }
    const outsideClass = targetStudentIds.filter((id) => !classStudentIds.has(id));
    if (outsideClass.length > 0) {
      throw Object.assign(new Error("One or more selected students are outside the active class"), { status: 400 });
    }
    const targetSet = new Set(targetStudentIds);
    selectedRows = classRows.filter((row) => targetSet.has(row.studentId));
  }

  if (scope === "subgroup") {
    const subgroupId = String(body.subgroupId || "").trim();
    if (!subgroupId) throw Object.assign(new Error("subgroupId is required when targetScope is subgroup"), { status: 400 });
    const subgroup = await getSubgroupByIdAndSchool(subgroupId, schoolId);
    if (!subgroup || subgroup.groupId !== group.id) {
      throw Object.assign(new Error("Subgroup is not part of the active class"), { status: 400 });
    }
    const members = await getSubgroupMembers(subgroupId);
    const memberIds = new Set(members.map((member) => member.studentId));
    selectedRows = classRows.filter((row) => memberIds.has(row.studentId));
    if (selectedRows.length === 0) {
      throw Object.assign(new Error("The selected subgroup has no students"), { status: 400 });
    }
  }

  const now = Date.now();
  const activeWindowMs = 5 * 60 * 1000;
  const resolved: ResolvedClasspilotCommandTarget[] = [];
  const activeCoverage = await getActiveSupervisionForStudents(
    schoolId,
    selectedRows.map((row) => row.studentId)
  );
  const coverageByStudent = new Map(activeCoverage.map((entry) => [entry.studentId, entry.context]));
  const activeClassOwners = await getActiveClassOwnersForStudents(
    schoolId,
    selectedRows.map((row) => row.studentId)
  );
  const classOwnerByStudent = new Map(activeClassOwners.map((owner) => [owner.studentId, owner]));
  for (const row of selectedRows) {
    const coverage = coverageByStudent.get(row.studentId);
    const studentName = [row.student.firstName, row.student.lastName].filter(Boolean).join(" ") || row.student.email || row.studentId;
    if (coverage) {
      resolved.push({
        studentId: row.studentId,
        studentName,
        studentSessionId: null,
        deviceId: null,
        available: false,
        unavailableReason: `Student is assigned to ${coverage.name}`,
      });
      continue;
    }
    const classOwner = classOwnerByStudent.get(row.studentId);
    if (classOwner && classOwner.session.id !== teachingSessionId) {
      resolved.push({
        studentId: row.studentId,
        studentName,
        studentSessionId: null,
        deviceId: null,
        available: false,
        unavailableReason: `Student is active in ${classOwner.groupName}`,
      });
      continue;
    }
    const studentSession = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = studentSession?.lastSeenAt?.getTime?.() ?? 0;
    const active = !!studentSession && lastSeenAt > 0 && now - lastSeenAt <= activeWindowMs;
    resolved.push({
      studentId: row.studentId,
      studentName,
      studentSessionId: active ? studentSession!.id : null,
      deviceId: active ? studentSession!.deviceId : null,
      available: active,
      unavailableReason: active ? undefined : "Student is not signed in to the extension",
    });
  }
  return resolved;
}

router.post("/commands", ...auth, async (req, res, next) => {
  try {
    const role = res.locals.membershipRole;
    if (!req.authUser?.isSuperAdmin && !["admin", "school_admin", "teacher"].includes(role)) {
      return res.status(403).json({ error: "Teacher or admin access required" });
    }

    const schoolId = res.locals.schoolId!;
    const teacherId = req.authUser!.id;
    const commandType = String(req.body.commandType || "").trim();
    const teachingSessionId = String(req.body.teachingSessionId || "").trim();
    const targetScope = normalizeTargetScope(req.body.targetScope);
    if (!targetScope) return res.status(400).json({ error: "targetScope must be class, subgroup, or students" });
    if (commandType === "student-sign-out" && targetScope !== "students") {
      return res.status(400).json({ error: "student-sign-out requires explicit targetStudentIds" });
    }

    const targets = await resolveTargets(req, res, req.body);
    const result = await executeClasspilotCommand({
      schoolId,
      actorId: teacherId,
      teachingSessionId,
      targetScope,
      subgroupId: req.body.subgroupId || null,
      commandType,
      rawCommandPayload: req.body.commandPayload || {},
      targets,
      persistClassroomState: true,
    });

    return res.status(201).json(result);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get("/commands/recent", ...auth, async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(25, Number(req.query.limit || 10)));
    const teachingSessionId = String(req.query.teachingSessionId || "").trim();
    const commands = await getRecentClasspilotCommands(
      res.locals.schoolId!,
      req.authUser!.id,
      teachingSessionId || null,
      limit
    );
    return res.json({
      commands: commands.map((command) => ({
        ...command,
        summary: commandSummary(command),
        message: resultMessage(command.commandType, commandSummary(command)),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/commands/active-state", ...auth, async (req, res, next) => {
  try {
    const teachingSessionId = String(req.query.teachingSessionId || "").trim();
    if (!teachingSessionId) return res.status(400).json({ error: "teachingSessionId query param required" });
    const session = await getTeachingSessionByIdAndSchool(teachingSessionId, res.locals.schoolId!);
    if (!session) return res.status(404).json({ error: "Class session not found" });
    const role = res.locals.membershipRole as string | undefined;
    const isAdmin = req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
    if (!isAdmin && session.teacherId !== req.authUser!.id) {
      const coTeachers = await getGroupTeachers(session.groupId);
      if (!coTeachers.some((teacher) => teacher.teacherId === req.authUser!.id)) {
        return res.status(403).json({ error: "This class session is not assigned to you" });
      }
    }
    const states = await getActiveClasspilotClassroomStates(res.locals.schoolId!, teachingSessionId);
    return res.json({ states });
  } catch (err) {
    next(err);
  }
});

export default router;
