import crypto from "crypto";
import {
  clearClasspilotClassroomStates,
  closePoll,
  createClasspilotCommandWithTargets,
  createMessage,
  createPoll,
  endStudentSession,
  getBlockListById,
  getClasspilotCommandByIdAndSchool,
  getFlightPathById,
  getPollById,
  markClasspilotCommandTargetsSent,
  upsertClasspilotClassroomStates,
  type ClasspilotCommandWithTargets,
} from "./storage.js";
import { broadcastToStaffSessionLocal, sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import {
  publishWS,
  publishWSBatch,
  recordCommandHotPathPhase,
  type PublishWSBatchItem,
} from "../realtime/ws-redis.js";
import { removeDeviceStatus } from "../realtime/student-statuses.js";

export type ClasspilotCommandTargetScope = "class" | "subgroup" | "students" | "context";

export type ResolvedClasspilotCommandTarget = {
  studentId: string;
  studentName: string;
  studentSessionId: string | null;
  deviceId: string | null;
  available: boolean;
  unavailableReason?: string;
};

export const COVERAGE_COMMAND_TYPES = new Set([
  "open-tab",
  "close-tabs",
  "lock-screen",
  "unlock-screen",
  "teacher-message",
  "apply-flight-path",
  "apply-block-list",
]);

export function normalizeStudentIds(value: unknown): string[] {
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

export function commandSummary(command: ClasspilotCommandWithTargets) {
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

export function resultMessage(commandType: string, summary: ReturnType<typeof commandSummary>): string {
  const unavailable = summary.unavailable ? ` - ${summary.unavailable} not signed in` : "";
  const failed = summary.failed ? ` - ${summary.failed} failed` : "";
  const awaiting = summary.awaitingAck ? ` - ${summary.awaitingAck} awaiting acknowledgement` : "";
  switch (commandType) {
    case "open-tab":
      return `Opened for ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "close-tabs":
      return `Close tabs sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "lock-screen":
      return `Locked ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "unlock-screen":
      return `Unlocked ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "student-sign-out":
      return `Signed out ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "apply-flight-path":
      return `Flight Path sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    case "apply-block-list":
      return `Block List sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
    default:
      return `Command sent to ${summary.sent} student${summary.sent === 1 ? "" : "s"}${unavailable}${failed}${awaiting}`;
  }
}

export async function normalizeCommandPayload(
  commandType: string,
  payload: any,
  schoolId: string,
  teacherId: string,
  teachingSessionId?: string | null
) {
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
    case "student-sign-out":
      if (!teachingSessionId) {
        throw Object.assign(new Error("Student sign-out requires an active class session"), { status: 400 });
      }
      return {
        extensionType: "student-sign-out",
        payload: {
          ...payload,
          reason: "teacher_sign_out",
          sessionId: teachingSessionId,
        },
      };
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
      if (!teachingSessionId) {
        throw Object.assign(new Error("Poll commands require an active class session"), { status: 400 });
      }
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

function payloadForTarget(
  commandType: string,
  extensionType: string,
  payload: any,
  target: ResolvedClasspilotCommandTarget
) {
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

async function endStudentSessionsForSignOut(options: {
  schoolId: string;
  teachingSessionId: string;
  targets: ResolvedClasspilotCommandTarget[];
}) {
  const seenSessionIds = new Set<string>();
  const seenDeviceIds = new Set<string>();

  for (const target of options.targets) {
    if (!target.deviceId) continue;
    if (target.studentSessionId && !seenSessionIds.has(target.studentSessionId)) {
      seenSessionIds.add(target.studentSessionId);
      await endStudentSession(target.studentSessionId);
    }
    if (seenDeviceIds.has(target.deviceId)) continue;
    seenDeviceIds.add(target.deviceId);

    removeDeviceStatus(options.schoolId, target.deviceId);
    const update = {
      type: "student-signed-out",
      studentId: target.studentId,
      deviceId: target.deviceId,
      schoolId: options.schoolId,
      sessionId: options.teachingSessionId,
      status: "offline",
      reason: "teacher_sign_out",
      timestamp: new Date().toISOString(),
    };
    broadcastToStaffSessionLocal(options.schoolId, options.teachingSessionId, update);
    await publishWS({ kind: "staff-session", schoolId: options.schoolId, sessionId: options.teachingSessionId }, update);
  }
}

async function persistActiveState(options: {
  schoolId: string;
  teachingSessionId: string;
  teacherId: string;
  commandId: string;
  commandType: string;
  payload: any;
  targets: ResolvedClasspilotCommandTarget[];
  sentTargets: ResolvedClasspilotCommandTarget[];
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

export async function executeClasspilotCommand(options: {
  schoolId: string;
  actorId: string;
  teachingSessionId?: string | null;
  supervisionContextId?: string | null;
  targetScope: ClasspilotCommandTargetScope;
  subgroupId?: string | null;
  commandType: string;
  rawCommandPayload: any;
  targets: ResolvedClasspilotCommandTarget[];
  persistClassroomState?: boolean;
}) {
  const normalized = await normalizeCommandPayload(
    options.commandType,
    options.rawCommandPayload || {},
    options.schoolId,
    options.actorId,
    options.teachingSessionId || null
  );
  const commandPayload = { ...normalized.payload };

  const created = await createClasspilotCommandWithTargets(
    {
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId || null,
      supervisionContextId: options.supervisionContextId || null,
      teacherId: options.actorId,
      targetScope: options.targetScope,
      subgroupId: options.subgroupId || null,
      commandType: options.commandType,
      commandPayload,
      requestedCount: options.targets.length,
      unavailableCount: options.targets.filter((target) => !target.available).length,
    },
    options.targets.map((target) => ({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId || null,
      supervisionContextId: options.supervisionContextId || null,
      commandId: "",
      studentId: target.studentId,
      studentSessionId: target.studentSessionId,
      deviceId: target.deviceId,
      status: target.available ? "requested" : "unavailable",
      errorMessage: target.available ? null : target.unavailableReason || "Student unavailable",
    }))
  );

  const sentTargets: ResolvedClasspilotCommandTarget[] = [];
  const deliveryCandidates: ResolvedClasspilotCommandTarget[] = [];
  const remotePublications: PublishWSBatchItem[] = [];
  const localDeliveryStartedAt = performance.now();
  let localDeliverySucceeded = false;
  try {
    for (const target of options.targets.filter((target) => target.available && target.deviceId)) {
      const message = payloadForTarget(options.commandType, normalized.extensionType, {
        ...commandPayload,
        commandId: created.id,
      }, target);
      if (!message) continue;

      if (options.commandType === "teacher-message") {
        await createMessage({
          fromUserId: options.actorId,
          toStudentId: target.studentId,
          message: commandPayload.message,
          isAnnouncement: false,
        }, options.schoolId);
      }

      // Keep both arrays in the caller's exact target order. Local delivery is
      // immediate; Redis publication below sends the corresponding envelopes in
      // that same order using one network round trip.
      sendToDeviceLocal(options.schoolId, target.deviceId!, message);
      remotePublications.push({
        target: { kind: "device", schoolId: options.schoolId, deviceId: target.deviceId! },
        message,
      });
      deliveryCandidates.push(target);
    }
    localDeliverySucceeded = true;
  } finally {
    recordCommandHotPathPhase(
      "command_local_delivery",
      performance.now() - localDeliveryStartedAt,
      { success: localDeliverySucceeded, items: deliveryCandidates.length }
    );
  }

  const redisPublishStartedAt = performance.now();
  let redisPublishSucceeded = false;
  let publicationResults: boolean[] = [];
  try {
    publicationResults = await publishWSBatch(remotePublications);
    redisPublishSucceeded = publicationResults.every(Boolean);
  } finally {
    recordCommandHotPathPhase(
      "command_redis_batch",
      performance.now() - redisPublishStartedAt,
      { success: redisPublishSucceeded, items: remotePublications.length }
    );
  }

  // `sent` records that this process attempted dispatch for a valid available
  // target, matching the established command contract. Local socket presence
  // and Redis subscriber count do not prove device receipt; received/completed
  // ACKs remain separately authoritative. Batch failures stay visible in the
  // phase metrics without changing the persisted dispatch-attempt semantics.
  sentTargets.push(...deliveryCandidates);

  const markSentStartedAt = performance.now();
  let markSentSucceeded = false;
  try {
    await markClasspilotCommandTargetsSent(
      created.id,
      sentTargets.map((target) => target.deviceId!).filter(Boolean)
    );
    markSentSucceeded = true;
  } finally {
    recordCommandHotPathPhase(
      "command_mark_sent",
      performance.now() - markSentStartedAt,
      { success: markSentSucceeded, items: sentTargets.length }
    );
  }
  if (options.commandType === "student-sign-out" && options.teachingSessionId) {
    await endStudentSessionsForSignOut({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      targets: sentTargets,
    });
  }
  if (options.persistClassroomState !== false && options.teachingSessionId) {
    await persistActiveState({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      teacherId: options.actorId,
      commandId: created.id,
      commandType: options.commandType,
      payload: commandPayload,
      targets: options.targets,
      sentTargets,
    });
  }
  const command = await getClasspilotCommandByIdAndSchool(created.id, options.schoolId);
  if (!command) throw Object.assign(new Error("Command was created but could not be loaded"), { status: 500 });
  const targetOrder = new Map(options.targets.map((target, index) => [target.studentId, index]));
  command.targets.sort((left, right) =>
    (targetOrder.get(left.studentId) ?? Number.MAX_SAFE_INTEGER)
    - (targetOrder.get(right.studentId) ?? Number.MAX_SAFE_INTEGER)
  );
  const summary = commandSummary(command);
  return {
    command,
    summary,
    message: resultMessage(options.commandType, summary),
    extra: normalized.extra || null,
  };
}
