import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  clearClasspilotClassroomStates,
  closePoll,
  createClasspilotCommandWithTargets,
  createMessage,
  createPoll,
  getActiveClasspilotClassroomStates,
  getActiveSessionByStudent,
  getBlockListById,
  getClasspilotCommandByIdAndSchool,
  getFlightPathById,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupTeachers,
  getPollById,
  getRecentClasspilotCommands,
  getSubgroupByIdAndSchool,
  getSubgroupMembers,
  getTeachingSessionByIdAndSchool,
  markClasspilotCommandTargetsSent,
  updateClasspilotCommandSummary,
  upsertClasspilotClassroomStates,
  type ClasspilotCommandWithTargets,
} from "../../services/storage.js";
import { sendToDeviceLocal } from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

type TargetScope = "class" | "subgroup" | "students";
type ResolvedTarget = {
  studentId: string;
  studentName: string;
  studentSessionId: string | null;
  deviceId: string | null;
  available: boolean;
  unavailableReason?: string;
};

function normalizeTargetScope(value: unknown): TargetScope | null {
  if (value === "class" || value === "subgroup" || value === "students") return value;
  return null;
}

function normalizeStudentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function ensureHttpUrl(raw: unknown, fieldName = "url"): string {
  const value = String(raw || "").trim();
  if (!value) throw Object.assign(new Error(`${fieldName} is required`), { status: 400 });
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw Object.assign(new Error(`${fieldName} must be a valid HTTP or HTTPS URL`), { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(new Error(`${fieldName} must be HTTP or HTTPS`), { status: 400 });
  }
  return parsed.toString();
}

function commandSummary(command: ClasspilotCommandWithTargets) {
  const targets = command.targets || [];
  const requested = targets.length;
  const sent = targets.filter((target) =>
    ["sent", "received", "completed", "failed"].includes(target.status)
  ).length;
  const received = targets.filter((target) =>
    ["received", "completed"].includes(target.status)
  ).length;
  const completed = targets.filter((target) => target.status === "completed").length;
  const failed = targets.filter((target) => target.status === "failed").length;
  const unavailable = targets.filter((target) => target.status === "unavailable").length;
  const acknowledged = targets.filter((target) =>
    ["received", "completed", "failed"].includes(target.status)
  ).length;
  return {
    requested,
    sent,
    received,
    completed,
    failed,
    unavailable,
    awaitingAck: Math.max(0, sent - acknowledged),
  };
}

function resultMessage(commandType: string, summary: ReturnType<typeof commandSummary>): string {
  const unavailable = summary.unavailable ? ` · ${summary.unavailable} not signed in` : "";
  const failed = summary.failed ? ` · ${summary.failed} failed` : "";
  const awaiting = summary.awaitingAck ? ` · ${summary.awaitingAck} awaiting acknowledgement` : "";
  switch (commandType) {
    case "open-tab":
      return `Opened for ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "close-tabs":
      return `Close tabs sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "lock-screen":
      return `Locked ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "unlock-screen":
      return `Unlocked ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "apply-flight-path":
      return `Flight Path sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "apply-block-list":
      return `Block List sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    default:
      return `Command sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
  }
}

async function resolveTargets(req: Request, res: Response, body: any): Promise<ResolvedTarget[]> {
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
  const resolved: ResolvedTarget[] = [];
  for (const row of selectedRows) {
    const studentSession = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = studentSession?.lastSeenAt?.getTime?.() ?? 0;
    const active = !!studentSession && lastSeenAt > 0 && now - lastSeenAt <= activeWindowMs;
    resolved.push({
      studentId: row.studentId,
      studentName: [row.student.firstName, row.student.lastName].filter(Boolean).join(" ") || row.student.email || row.studentId,
      studentSessionId: active ? studentSession!.id : null,
      deviceId: active ? studentSession!.deviceId : null,
      available: active,
      unavailableReason: active ? undefined : "Student is not signed in to the extension",
    });
  }
  return resolved;
}

async function normalizeCommandPayload(commandType: string, payload: any, schoolId: string, teacherId: string, teachingSessionId: string) {
  switch (commandType) {
    case "open-tab":
      return { extensionType: "open-tab", payload: { ...payload, url: ensureHttpUrl(payload?.url) } };
    case "lock-screen":
      return { extensionType: "lock-screen", payload: { ...payload, url: payload?.url === "CURRENT_URL" ? "CURRENT_URL" : ensureHttpUrl(payload?.url) } };
    case "close-tabs":
      return { extensionType: "close-tab", payload: { ...payload } };
    case "unlock-screen":
    case "remove-flight-path":
    case "remove-block-list":
      return { extensionType: commandType, payload: { ...payload } };
    case "attention-mode":
    case "timer":
    case "temp-unblock":
    case "limit-tabs":
      return { extensionType: commandType, payload: { ...payload } };
    case "apply-flight-path": {
      const flightPathId = String(payload?.flightPathId || "").trim();
      const flightPath = flightPathId ? await getFlightPathById(flightPathId, schoolId) : undefined;
      if (!flightPath) throw Object.assign(new Error("Flight Path not found"), { status: 404 });
      return {
        extensionType: "apply-flight-path",
        payload: {
          flightPathId: flightPath.id,
          flightPathName: flightPath.flightPathName,
          allowedDomains: flightPath.allowedDomains || [],
        },
      };
    }
    case "apply-block-list": {
      const blockListId = String(payload?.blockListId || "").trim();
      const blockList = blockListId ? await getBlockListById(blockListId, schoolId) : undefined;
      if (!blockList) throw Object.assign(new Error("Block List not found"), { status: 404 });
      return {
        extensionType: "apply-block-list",
        payload: {
          blockListId: blockList.id,
          blockListName: blockList.name,
          blockedDomains: blockList.blockedDomains || [],
        },
      };
    }
    case "poll": {
      const action = payload?.action || "start";
      if (action === "start") {
        const question = String(payload?.question || "").trim();
        const options = Array.isArray(payload?.options) ? payload.options.map((o: unknown) => String(o).trim()).filter(Boolean) : [];
        if (!question || options.length < 2) {
          throw Object.assign(new Error("Poll question and at least two options are required"), { status: 400 });
        }
        const poll = await createPoll({ sessionId: teachingSessionId, teacherId, question, options });
        return {
          extensionType: "poll",
          payload: { action: "start", pollId: poll.id, question, options },
          extra: { poll },
        };
      }
      const pollId = String(payload?.pollId || "").trim();
      const poll = pollId ? await getPollById(pollId) : undefined;
      if (!poll || poll.sessionId !== teachingSessionId) {
        throw Object.assign(new Error("Poll not found for this class session"), { status: 404 });
      }
      const closed = await closePoll(pollId);
      return {
        extensionType: "poll",
        payload: { action: "close", pollId },
        extra: { poll: closed || poll },
      };
    }
    case "teacher-message": {
      const message = String(payload?.message || "").trim();
      if (!message) throw Object.assign(new Error("message is required"), { status: 400 });
      return { extensionType: "teacher-message", payload: { message } };
    }
    default:
      throw Object.assign(new Error(`Unsupported commandType: ${commandType}`), { status: 400 });
  }
}

function payloadForTarget(commandType: string, extensionType: string, payload: any, target: ResolvedTarget) {
  if (commandType === "close-tabs" && Array.isArray(payload?.tabsToClose)) {
    const ownTabs = payload.tabsToClose.filter((tab: any) =>
      String(tab.studentId || "") === target.studentId ||
      (tab.deviceId && target.deviceId && String(tab.deviceId) === target.deviceId)
    );
    if (!payload.closeAll && ownTabs.length === 0) return null;
    return {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      commandId: payload.commandId,
      command: {
        type: extensionType,
        commandId: payload.commandId,
        data: {
          ...payload,
          tabsToClose: undefined,
          specificUrls: ownTabs.map((tab: any) => String(tab.url || "").trim()).filter(Boolean),
        },
      },
    };
  }

  if (commandType === "teacher-message") {
    return {
      type: "teacher-message",
      _msgId: crypto.randomUUID(),
      commandId: payload.commandId,
      message: payload.message,
      fromName: "Teacher",
    };
  }

  return {
    type: "remote-control",
    _msgId: crypto.randomUUID(),
    commandId: payload.commandId,
    command: {
      type: extensionType,
      commandId: payload.commandId,
      data: { ...payload },
    },
  };
}

async function persistActiveState(options: {
  schoolId: string;
  teachingSessionId: string;
  teacherId: string;
  commandId: string;
  commandType: string;
  payload: any;
  targets: ResolvedTarget[];
  sentTargets: ResolvedTarget[];
}) {
  const targetStudentIds = options.targets.map((target) => target.studentId);
  const sentStudentIds = options.sentTargets.map((target) => target.studentId);
  const base = {
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    commandId: options.commandId,
    appliedBy: options.teacherId,
  };

  if (options.commandType === "unlock-screen") {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["screen-lock", "flight-path"],
      commandId: options.commandId,
    });
    return;
  }
  if (options.commandType === "remove-flight-path" || options.commandType === "remove-block-list") {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: [options.commandType === "remove-flight-path" ? "flight-path" : "block-list"],
      commandId: options.commandId,
    });
    return;
  }
  if (options.commandType === "attention-mode" && options.payload.active === false) {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["attention"],
      commandId: options.commandId,
    });
    return;
  }
  if (options.commandType === "timer" && options.payload.action === "stop") {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["timer"],
      commandId: options.commandId,
    });
    return;
  }
  if (options.commandType === "poll" && options.payload.action === "close") {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["poll"],
      commandId: options.commandId,
    });
    return;
  }

  const stateTypeByCommand: Record<string, string | undefined> = {
    "lock-screen": "screen-lock",
    "apply-flight-path": "flight-path",
    "apply-block-list": "block-list",
    "attention-mode": options.payload.active === false ? undefined : "attention",
    timer: options.payload.action === "start" ? "timer" : undefined,
    poll: options.payload.action === "start" ? "poll" : undefined,
  };
  const stateType = stateTypeByCommand[options.commandType];
  if (!stateType) return;

  if (options.commandType === "apply-flight-path" && sentStudentIds.length > 0) {
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: sentStudentIds,
      stateTypes: ["screen-lock"],
      commandId: options.commandId,
    });
  }

  await upsertClasspilotClassroomStates(options.sentTargets.map((target) => ({
    ...base,
    studentId: target.studentId,
    stateType,
    stateKey: options.payload.flightPathId || options.payload.blockListId || options.payload.pollId || "active",
    payload: options.payload,
    expiresAt: options.payload.expiresAt ? new Date(options.payload.expiresAt) : null,
  })));
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
    const targets = await resolveTargets(req, res, req.body);
    const normalized = await normalizeCommandPayload(
      commandType,
      req.body.commandPayload || {},
      schoolId,
      teacherId,
      teachingSessionId
    );
    const commandPayload = { ...normalized.payload };
    const targetScope = normalizeTargetScope(req.body.targetScope);
    if (!targetScope) return res.status(400).json({ error: "targetScope must be class, subgroup, or students" });

    const created = await createClasspilotCommandWithTargets(
      {
        schoolId,
        teachingSessionId,
        teacherId,
        targetScope,
        subgroupId: req.body.subgroupId || null,
        commandType,
        commandPayload,
        requestedCount: targets.length,
        unavailableCount: targets.filter((target) => !target.available).length,
      },
      targets.map((target) => ({
        schoolId,
        teachingSessionId,
        commandId: "",
        studentId: target.studentId,
        studentSessionId: target.studentSessionId,
        deviceId: target.deviceId,
        status: target.available ? "requested" : "unavailable",
        errorMessage: target.available ? null : target.unavailableReason || "Student unavailable",
      }))
    );

    const sentTargets: ResolvedTarget[] = [];
    for (const target of targets.filter((target) => target.available && target.deviceId)) {
      const message = payloadForTarget(commandType, normalized.extensionType, {
        ...commandPayload,
        commandId: created.id,
      }, target);
      if (!message) continue;

      if (commandType === "teacher-message") {
        await createMessage({
          fromUserId: teacherId,
          toStudentId: target.studentId,
          message: commandPayload.message,
          isAnnouncement: false,
        }, schoolId);
      }

      sendToDeviceLocal(schoolId, target.deviceId!, message);
      await publishWS({ kind: "device", schoolId, deviceId: target.deviceId! }, message);
      sentTargets.push(target);
    }

    await markClasspilotCommandTargetsSent(created.id, sentTargets.map((target) => target.deviceId!).filter(Boolean));
    await persistActiveState({
      schoolId,
      teachingSessionId,
      teacherId,
      commandId: created.id,
      commandType,
      payload: commandPayload,
      targets,
      sentTargets,
    });
    await updateClasspilotCommandSummary(created.id);

    const command = await getClasspilotCommandByIdAndSchool(created.id, schoolId);
    if (!command) return res.status(500).json({ error: "Command was created but could not be loaded" });
    const summary = commandSummary(command);
    return res.status(201).json({
      command,
      summary,
      message: resultMessage(commandType, summary),
      extra: normalized.extra || null,
    });
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
