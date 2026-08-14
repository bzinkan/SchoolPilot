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
  markClasspilotCommandTargetsServerCompleted,
  persistClasspilotControlCommandState,
  replaceClasspilotSupervisionControlSnapshots,
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
import {
  markClasspilotRealtimeSignedOut,
} from "./classpilotRealtimeStatus.js";
import {
  applyClasspilotControlCommand,
  emptyClasspilotRestrictions,
  normalizeClasspilotRestrictions,
  serializeClasspilotStudentControlState,
} from "./classpilotClassroomState.js";
import {
  classpilotCommandDeliveryPolicy,
  classpilotCommandExpiresAt,
  isPersistentClasspilotControl,
  summarizeClasspilotCommandTargets,
  type ClasspilotCommandDeliveryPolicy,
} from "./classpilotCommandDelivery.js";
import { recordClasspilotStudentSessionMonitoringEvent } from "./classpilotMonitoringEvents.js";
import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../schema/classpilot.js";

export type ClasspilotCommandTargetScope = "class" | "subgroup" | "students" | "context";

export type ResolvedClasspilotCommandTarget = {
  studentId: string;
  studentName: string;
  studentSessionId: string | null;
  deviceId: string | null;
  available: boolean;
  /** Whether this command's scope currently owns the student's desired state. */
  stateAuthorized?: boolean;
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

function requireRuleListWithinExtensionLimit(value: unknown, label: string): unknown[] {
  const list = Array.isArray(value) ? value : [];
  if (list.length > 1_000) {
    throw Object.assign(
      new Error(`${label} cannot contain more than 1,000 entries`),
      { status: 400, code: "CLASSROOM_RULE_LIMIT_EXCEEDED" }
    );
  }
  return list;
}

export function commandSummary(command: ClasspilotCommandWithTargets) {
  return summarizeClasspilotCommandTargets(command);
}

export function resultMessage(commandType: string, summary: ReturnType<typeof commandSummary>): string {
  const unavailable = summary.unavailable ? ` - ${summary.unavailable} student unavailable` : "";
  const expired = summary.expired ? ` - ${summary.expired} not delivered` : "";
  const failed = summary.failed ? ` - ${summary.failed} failed` : "";
  const awaiting = summary.awaitingAck ? ` - ${summary.awaitingAck} awaiting device acknowledgement` : "";
  const policy = classpilotCommandDeliveryPolicy(commandType);
  if (policy === "persistent_control") {
    return `Restriction saved${unavailable}${failed}${awaiting}`;
  }
  if (policy === "durable_message") {
    return `Message queued for ${summary.requested} student${summary.requested === 1 ? "" : "s"}${unavailable}${failed}`;
  }
  if (policy === "server_authoritative") {
    return `Student session ended for ${summary.completed} student${summary.completed === 1 ? "" : "s"}${unavailable}${failed}`;
  }
  return `Delivery attempted for ${summary.attempted} student${summary.attempted === 1 ? "" : "s"}${unavailable}${expired}${failed}${awaiting}`;
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
      const allowedDomains = requireRuleListWithinExtensionLimit(
        flightPath.allowedDomains,
        "Flight Path"
      );
      return {
        extensionType: "apply-flight-path",
        payload: {
          flightPathId: flightPath.id,
          flightPathName: flightPath.flightPathName,
          allowedDomains,
        },
      };
    }
    case "apply-block-list": {
      const blockListId = String(payload?.blockListId || "").trim();
      const blockList = blockListId ? await getBlockListById(blockListId, schoolId) : undefined;
      if (!blockList) throw Object.assign(new Error("Block List not found"), { status: 404 });
      const blockedDomains = requireRuleListWithinExtensionLimit(
        blockList.blockedDomains,
        "Block List"
      );
      return {
        extensionType: "apply-block-list",
        payload: {
          blockListId: blockList.id,
          blockListName: blockList.name,
          blockedDomains,
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
  target: ResolvedClasspilotCommandTarget,
  delivery: {
    policy: ClasspilotCommandDeliveryPolicy;
    expiresAt: Date | null;
  },
  classroomState?: ReturnType<typeof serializeClasspilotStudentControlState>
) {
  const deliveryEnvelope = {
    deliveryPolicy: delivery.policy,
    expiresAt: delivery.expiresAt?.toISOString() || null,
  };
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
      ...deliveryEnvelope,
      command: {
        type: extensionType,
        commandId: payload.commandId,
        ...deliveryEnvelope,
        data: {
          ...payload,
          tabsToClose: undefined,
          specificUrls: ownTabs.map((tab: any) => String(tab.url || "").trim()).filter(Boolean),
        },
      },
      ...(classroomState ? { classroomState } : {}),
    };
  }

  if (commandType === "teacher-message") {
    return {
      type: "teacher-message",
      _msgId: payload.messageId || crypto.randomUUID(),
      messageId: payload.messageId || undefined,
      commandId: payload.commandId,
      ...deliveryEnvelope,
      message: payload.message,
      fromName: "Teacher",
    };
  }

  return {
    type: "remote-control",
    _msgId: crypto.randomUUID(),
    commandId: payload.commandId,
    ...deliveryEnvelope,
    command: {
      type: extensionType,
      commandId: payload.commandId,
      ...deliveryEnvelope,
      data: { ...payload },
    },
    ...(classroomState ? { classroomState } : {}),
  };
}

async function endStudentSessionsForSignOut(options: {
  schoolId: string;
  teachingSessionId: string;
  commandId: string;
  targets: ResolvedClasspilotCommandTarget[];
}) {
  const seenSessionIds = new Set<string>();
  const seenDeviceIds = new Set<string>();
  const completedStudentIds = new Set<string>();

  for (const target of options.targets) {
    if (!target.deviceId) continue;
    if (target.studentSessionId && !seenSessionIds.has(target.studentSessionId)) {
      seenSessionIds.add(target.studentSessionId);
      const endedSession = await endStudentSession(target.studentSessionId);
      if (endedSession) completedStudentIds.add(target.studentId);
      void recordClasspilotStudentSessionMonitoringEvent({
        schoolId: options.schoolId,
        studentId: target.studentId,
        studentSessionId: target.studentSessionId,
        deviceId: target.deviceId,
        type: "student_session_ended",
        reason: "teacher_sign_out",
      }).catch(() => { /* lifecycle telemetry must not block sign-out */ });
    }
    if (seenDeviceIds.has(target.deviceId)) continue;
    seenDeviceIds.add(target.deviceId);

    removeDeviceStatus(options.schoolId, target.deviceId);
    const realtimeMutation = target.studentSessionId
      ? await markClasspilotRealtimeSignedOut({
          schoolId: options.schoolId,
          studentId: target.studentId,
          studentSessionId: target.studentSessionId,
          deviceId: target.deviceId,
          reason: "teacher_sign_out",
        })
      : null;
    const realtimeSnapshot = realtimeMutation?.snapshot;
    const update = {
      type: "student-signed-out",
      studentId: target.studentId,
      schoolId: options.schoolId,
      sessionId: options.teachingSessionId,
      status: "offline",
      reason: "teacher_sign_out",
      timestamp: new Date().toISOString(),
      schemaVersion: 2,
      ...(realtimeSnapshot ? {
        realtimeRevision: realtimeSnapshot.revision,
        revision: realtimeSnapshot.revision,
        realtimeObservedAt: new Date(realtimeSnapshot.observedAt).toISOString(),
        observedAtMs: realtimeSnapshot.observedAt,
        state: "signed_out",
      } : {}),
    };
    broadcastToStaffSessionLocal(options.schoolId, options.teachingSessionId, update);
    await publishWS({ kind: "staff-session", schoolId: options.schoolId, sessionId: options.teachingSessionId }, update);
  }
  await markClasspilotCommandTargetsServerCompleted(
    options.commandId,
    [...completedStudentIds]
  );
}

async function persistActiveState(options: {
  schoolId: string;
  teachingSessionId: string;
  teacherId: string;
  commandId: string;
  commandType: string;
  payload: any;
  targets: ResolvedClasspilotCommandTarget[];
}) {
  const targetStudentIds = options.targets.map((target) => target.studentId);
  if (targetStudentIds.length === 0) return [];
  const now = new Date();
  const base = {
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    commandId: options.commandId,
    appliedBy: options.teacherId,
  };

  // Timer and poll commands are transient actions. A dispatch attempt is not
  // evidence that a device received or applied one, so they must not create an
  // authoritative active-state row. Clear legacy rows on every transition;
  // the command target acknowledgements (and the poll record itself) remain
  // the truthful delivery/lifecycle sources.
  if (options.commandType === "timer" || options.commandType === "poll") {
    const stateType = options.commandType;
    await clearClasspilotClassroomStates({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: [stateType],
      commandId: options.commandId,
    });
    return [];
  }
  if (!isPersistentClasspilotControl(options.commandType)) return [];

  const classroomStateClears: Array<{
    schoolId: string;
    teachingSessionId: string;
    studentIds: string[];
    stateTypes: string[];
    commandId: string;
  }> = [];
  if (options.commandType === "unlock-screen") {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["screen-lock", "flight-path"],
      commandId: options.commandId,
    });
  }
  if (options.commandType === "remove-flight-path" || options.commandType === "remove-block-list") {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: [options.commandType === "remove-flight-path" ? "flight-path" : "block-list"],
      commandId: options.commandId,
    });
  }
  if (options.commandType === "attention-mode" && options.payload.active === false) {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["attention"],
      commandId: options.commandId,
    });
  }
  if (options.commandType === "limit-tabs" && !options.payload.maxTabs) {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["tab-limit"],
      commandId: options.commandId,
    });
  }

  const stateTypeByCommand: Record<string, string | undefined> = {
    "lock-screen": "screen-lock",
    "apply-flight-path": "flight-path",
    "apply-block-list": "block-list",
    "attention-mode": options.payload.active === false ? undefined : "attention",
    "limit-tabs": options.payload.maxTabs ? "tab-limit" : undefined,
    "temp-unblock": "temporary-allow",
  };
  const stateType = stateTypeByCommand[options.commandType];

  if (options.commandType === "apply-flight-path" && targetStudentIds.length > 0) {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      // The full-state contract can represent one active Flight Path. Clear a
      // prior path as well as the mutually exclusive screen lock before the
      // new legacy/audit row is inserted.
      stateTypes: ["screen-lock", "flight-path"],
      commandId: options.commandId,
    });
  }
  if (options.commandType === "apply-block-list" && targetStudentIds.length > 0) {
    classroomStateClears.push({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      stateTypes: ["block-list"],
      commandId: options.commandId,
    });
  }

  const result = await persistClasspilotControlCommandState({
    classroomStateClears,
    classroomStateUpserts: stateType ? options.targets.map((target) => ({
      ...base,
      studentId: target.studentId,
      stateType,
      stateKey: options.payload.flightPathId || options.payload.blockListId || options.payload.domain || options.payload.pollId || "active",
      payload: options.payload,
      expiresAt: options.payload.expiresAt
        ? new Date(options.payload.expiresAt)
        : options.commandType === "temp-unblock"
          ? new Date(now.getTime() + Math.min(720, Math.max(1, Number(options.payload.durationMinutes) || 5)) * 60_000)
          : null,
    })) : [],
    studentSnapshots: {
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      studentIds: targetStudentIds,
      sourceCommandId: options.commandId,
      now,
      desiredState: (
        studentId: string,
        current: ClasspilotStudentControlState | null,
        activeStates: ClasspilotClassroomState[]
      ) => {
        const baseRestrictions = current?.teachingSessionId === options.teachingSessionId
          ? normalizeClasspilotRestrictions((current.desiredState as any)?.restrictions ?? current.desiredState)
          : activeStates.length > 0
            ? activeStates
                .filter((state) => state.studentId === studentId)
                .reduce(
                  (state, row) => applyClasspilotControlCommand(state, ({
                    "screen-lock": "lock-screen",
                    "flight-path": "apply-flight-path",
                    "block-list": "apply-block-list",
                    attention: "attention-mode",
                    "tab-limit": "limit-tabs",
                    "temporary-allow": "temp-unblock",
                  } as Record<string, string>)[row.stateType] || "", row.payload, now),
                  emptyClasspilotRestrictions()
                )
            : emptyClasspilotRestrictions();
        return { restrictions: applyClasspilotControlCommand(baseRestrictions, options.commandType, options.payload, now) };
      },
    },
  });
  return result.studentControlStates;
}

async function persistActiveSupervisionState(options: {
  schoolId: string;
  supervisionContextId: string;
  commandId: string;
  commandType: string;
  payload: any;
  targets: ResolvedClasspilotCommandTarget[];
  actorId: string;
  actorIsAdmin: boolean;
}) {
  const studentIds = options.targets.map((target) => target.studentId);
  return replaceClasspilotSupervisionControlSnapshots({
    schoolId: options.schoolId,
    supervisionContextId: options.supervisionContextId,
    studentIds,
    sourceCommandId: options.commandId,
    authorizedActorId: options.actorId,
    actorIsAdmin: options.actorIsAdmin,
    desiredState: (_studentId: string, current: ClasspilotStudentControlState | null) => {
      const baseRestrictions = current?.supervisionContextId === options.supervisionContextId
        ? normalizeClasspilotRestrictions((current.desiredState as any)?.restrictions ?? current.desiredState)
        : emptyClasspilotRestrictions();
      return {
        restrictions: applyClasspilotControlCommand(
          baseRestrictions,
          options.commandType,
          options.payload
        ),
      };
    },
  });
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
  supervisionActorIsAdmin?: boolean;
}) {
  const normalized = await normalizeCommandPayload(
    options.commandType,
    options.rawCommandPayload || {},
    options.schoolId,
    options.actorId,
    options.teachingSessionId || null
  );
  const commandPayload = { ...normalized.payload };
  const issuedAt = new Date();
  const deliveryPolicy = classpilotCommandDeliveryPolicy(options.commandType);
  const expiresAt = classpilotCommandExpiresAt(options.commandType, issuedAt);

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
      expiresAt,
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

  const shouldPersistBeforeDelivery = deliveryPolicy === "persistent_control";
  const stateAuthorizedTargets = options.targets.filter((target) => target.stateAuthorized !== false);
  const durableMessageIdByStudent = new Map<string, string>();
  if (deliveryPolicy === "durable_message") {
    // The pending-message inbox is the durable authority. Persist once for
    // every authorized selected student even if no live device is reachable.
    for (const target of stateAuthorizedTargets) {
      const message = await createMessage({
        fromUserId: options.actorId,
        toStudentId: target.studentId,
        message: commandPayload.message,
        isAnnouncement: false,
      }, options.schoolId);
      durableMessageIdByStudent.set(target.studentId, message.id);
    }
  }
  const controlStateRows = shouldPersistBeforeDelivery
    && options.persistClassroomState !== false
    && options.teachingSessionId
    ? await persistActiveState({
        schoolId: options.schoolId,
        teachingSessionId: options.teachingSessionId,
        teacherId: options.actorId,
        commandId: created.id,
        commandType: options.commandType,
        payload: commandPayload,
        targets: stateAuthorizedTargets,
      })
    : shouldPersistBeforeDelivery
      && options.persistClassroomState !== false
      && options.supervisionContextId
      ? await persistActiveSupervisionState({
          schoolId: options.schoolId,
          supervisionContextId: options.supervisionContextId,
          commandId: created.id,
          commandType: options.commandType,
          payload: commandPayload,
          targets: stateAuthorizedTargets,
          actorId: options.actorId,
          actorIsAdmin: options.supervisionActorIsAdmin === true,
        })
    : [];
  const classroomStateByStudent = new Map(controlStateRows.map((row) => [
    row.studentId,
    serializeClasspilotStudentControlState(row),
  ]));

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
        messageId: durableMessageIdByStudent.get(target.studentId),
      }, target, {
        policy: deliveryPolicy,
        expiresAt,
      }, classroomStateByStudent.get(target.studentId));
      if (!message) continue;

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
      commandId: created.id,
      targets: sentTargets,
    });
  }
  if (
    !shouldPersistBeforeDelivery
    && options.persistClassroomState !== false
    && options.teachingSessionId
  ) {
    await persistActiveState({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      teacherId: options.actorId,
      commandId: created.id,
      commandType: options.commandType,
      payload: commandPayload,
      targets: stateAuthorizedTargets,
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
    deliveryPolicy,
    expiresAt: command.expiresAt,
    summary,
    message: resultMessage(options.commandType, summary),
    enforcement: controlStateRows.map((state) => ({
      studentId: state.studentId,
      revision: state.revision,
      health: state.enforcementHealth,
    })),
    extra: normalized.extra || null,
  };
}
