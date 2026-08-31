import crypto from "crypto";
import {
  clearClasspilotClassroomStates,
  createClasspilotCommandWithTargets,
  createMessage,
  endStudentSessionExact,
  getBlockListById,
  getClasspilotCommandByIdAndSchool,
  getClasspilotStudentControlState,
  getFlightPathById,
  getPollById,
  markClasspilotCommandTargetsUnavailable,
  markClasspilotCommandTargetsSent,
  markClasspilotCommandTargetsServerCompleted,
  persistClasspilotControlCommandState,
  replaceClasspilotSupervisionControlSnapshots,
  revalidateClasspilotExactCommandTargetsForDispatch,
  type ClasspilotCommandWithTargets,
  type ClasspilotCommandPollMutation,
} from "./storage.js";
import { validateClasspilotCommandPayload } from "./classpilotCommandValidation.js";
import { broadcastToStaffSessionLocal, sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import {
  publishWS,
  publishWSBatch,
  recordCommandHotPathPhase,
  type PublishWSBatchItem,
} from "../realtime/ws-redis.js";
import {
  readClasspilotRealtimeStatusBatch,
  classpilotRealtimeFresh,
} from "./classpilotRealtimeStatus.js";
import {
  applyClasspilotControlCommand,
  emptyClasspilotRestrictions,
  normalizeClasspilotRestrictions,
  readClasspilotLateSignInDeliveryProvenance,
  serializeClasspilotStudentControlState,
  serializeClasspilotStudentControlStateForDelivery,
  withClasspilotLateSignInOrigin,
} from "./classpilotClassroomState.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { countClasspilotCurrentPageSignedOutSkips } from "./classpilotCurrentPage.js";
import {
  classpilotCommandDeliveryPolicy,
  classpilotCommandExpiresAt,
  isPersistentClasspilotControl,
  summarizeClasspilotCommandTargets,
  type ClasspilotCommandDeliveryPolicy,
} from "./classpilotCommandDelivery.js";
import { publishClasspilotStudentSessionEnded } from "./classpilotStudentSessionLifecycle.js";
import type {
  ClasspilotClassroomState,
  ClasspilotStudentControlState,
} from "../schema/classpilot.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { classpilotExactTabCloseVersion } from "./classpilotExactTabCapability.js";
import { classpilotControlStateExactBinding } from "./classpilotControlStateFrame.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";

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
  durableAuthorityRevision?: number;
  controlRevision?: number;
  exactTabCloseVersion?: 1 | 2;
  /** Structurally commandable signed-out target admitted by the exact-school gate. */
  lateSignInEligible?: boolean;
};

export const COVERAGE_COMMAND_TYPES = new Set([
  "open-tab",
  "close-tabs",
  "lock-screen",
  "unlock-screen",
  "teacher-message",
  "apply-flight-path",
  "remove-flight-path",
  "apply-block-list",
  "remove-block-list",
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
): Promise<{
  extensionType: string;
  payload: Record<string, any>;
  extra?: {
    pollMutation?: ClasspilotCommandPollMutation;
    pollCloseAuthority?: {
      targetScope: ClasspilotCommandTargetScope;
      subgroupId: string | null;
      targets: ResolvedClasspilotCommandTarget[];
    };
  };
}> {
  const validated = validateClasspilotCommandPayload(commandType, payload ?? {});
  switch (commandType) {
    case "open-tab":
      return { extensionType: "open-tab", payload: validated };
    case "lock-screen":
      return { extensionType: "lock-screen", payload: validated };
    case "close-tabs":
      return {
        extensionType: validated.closeAll === true ? "close-tabs" : "close-tab",
        payload: validated,
      };
    case "unlock-screen":
    case "remove-flight-path":
    case "remove-block-list":
      return { extensionType: commandType, payload: validated };
    case "attention-mode":
    case "timer":
    case "temp-unblock":
    case "limit-tabs":
      return { extensionType: commandType, payload: validated };
    case "student-sign-out":
      if (!teachingSessionId) {
        throw Object.assign(new Error("Student sign-out requires an active class session"), { status: 400 });
      }
      return {
        extensionType: "student-sign-out",
        payload: {
          ...validated,
          reason: "teacher_sign_out",
          sessionId: teachingSessionId,
        },
      };
    case "apply-flight-path": {
      const flightPathId = String(validated.flightPathId || "").trim();
      const flightPath = flightPathId
        ? await getFlightPathById(flightPathId, schoolId, teacherId)
        : undefined;
      if (!flightPath) throw Object.assign(new Error("Flight Path not found"), { status: 404 });
      const allowedDomains = requireRuleListWithinExtensionLimit(
        flightPath.allowedDomains,
        "Flight Path"
      );
      if (allowedDomains.length === 0) {
        throw Object.assign(new Error("Flight Path has no allowed domains"), {
          status: 409,
          code: "FLIGHT_PATH_EMPTY",
        });
      }
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
      const blockListId = String(validated.blockListId || "").trim();
      const blockList = blockListId
        ? await getBlockListById(blockListId, schoolId, teacherId)
        : undefined;
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
      const action = validated.action || "start";
      if (action === "start") {
        const question = String(validated.question);
        const options = validated.options as string[];
        const pollId = crypto.randomUUID();
        return {
          extensionType: "poll",
          payload: { action: "start", pollId, question, options },
          extra: { pollMutation: { action: "start" as const, pollId, question, options } },
        };
      }
      const pollId = String(validated.pollId || "").trim();
      const poll = pollId ? await getPollById(pollId, schoolId) : undefined;
      if (!poll || poll.sessionId !== teachingSessionId) {
        throw Object.assign(new Error("Poll not found for this class session"), { status: 404 });
      }
      if (!poll.startCommandId) {
        throw Object.assign(new Error("Poll is missing its frozen target authority"), {
          status: 409,
          code: "POLL_TARGET_AUTHORITY_MISSING",
        });
      }
      const startCommand = await getClasspilotCommandByIdAndSchool(poll.startCommandId, schoolId);
      if (!startCommand || startCommand.teachingSessionId !== teachingSessionId) {
        throw Object.assign(new Error("Poll start authority is unavailable"), {
          status: 409,
          code: "POLL_TARGET_AUTHORITY_MISSING",
        });
      }
      return {
        extensionType: "poll",
        payload: { action: "close", pollId },
        extra: {
          pollMutation: { action: "close" as const, pollId },
          pollCloseAuthority: {
            targetScope: startCommand.targetScope as ClasspilotCommandTargetScope,
            subgroupId: startCommand.subgroupId,
            targets: startCommand.targets.map((target) => {
              const available = target.status !== "unavailable"
                && !!target.studentSessionId
                && !!target.deviceId;
              return {
                studentId: target.studentId,
                studentName: target.studentId,
                studentSessionId: available ? target.studentSessionId : null,
                deviceId: available ? target.deviceId : null,
                available,
                stateAuthorized: available,
                unavailableReason: available
                  ? undefined
                  : "Student was unavailable when the poll started",
              };
            }),
          },
        },
      };
    }
    case "teacher-message": {
      return { extensionType: "teacher-message", payload: validated };
    }
    default:
      throw Object.assign(new Error(`Unsupported commandType: ${commandType}`), { status: 400 });
  }
}

type ExactTabOutcome = {
  studentId: string;
  tabRef: string;
  status: "accepted" | "stale_tab_ref" | "unsupported" | "unavailable";
};

async function authorizeExactTabClose(options: {
  schoolId: string;
  payload: Record<string, any>;
  targets: ResolvedClasspilotCommandTarget[];
}): Promise<{ targets: ResolvedClasspilotCommandTarget[]; outcomes: ExactTabOutcome[] }> {
  const selected = Array.isArray(options.payload.tabsToClose)
    ? options.payload.tabsToClose as Array<{ studentId: string; tabRef: string; observedRevision: number }>
    : [];
  if (selected.length === 0) return { targets: options.targets, outcomes: [] };
  const targetStudentIds = new Set(options.targets.map((target) => target.studentId));
  if (selected.some((row) => !targetStudentIds.has(row.studentId))) {
    throw Object.assign(new Error("An exact tab selection is outside the requested student targets"), {
      status: 400,
      code: "TAB_TARGET_OUTSIDE_COMMAND_SCOPE",
    });
  }

  const bindings = options.targets
    .filter((target) => target.available && target.studentSessionId && target.deviceId)
    .map((target) => ({
      studentId: target.studentId,
      studentSessionId: target.studentSessionId!,
      deviceId: target.deviceId!,
    }));
  const snapshots = await readClasspilotRealtimeStatusBatch(options.schoolId, bindings);
  const rowsByStudent = new Map<string, typeof selected>();
  for (const row of selected) {
    const rows = rowsByStudent.get(row.studentId) || [];
    rows.push(row);
    rowsByStudent.set(row.studentId, rows);
  }
  const outcomes: ExactTabOutcome[] = [];
  const targets = options.targets.map((target) => {
    const rows = rowsByStudent.get(target.studentId) || [];
    if (rows.length === 0) return target;
    if (!target.available || !target.deviceId || !target.studentSessionId) {
      outcomes.push(...rows.map((row) => ({
        studentId: target.studentId,
        tabRef: row.tabRef,
        status: "unavailable" as const,
      })));
      return target;
    }
    const read = snapshots.get(target.studentId);
    const snapshot = read?.status === "hit" ? read.snapshot : null;
    if (!snapshot || !classpilotRealtimeFresh(snapshot)) {
      outcomes.push(...rows.map((row) => ({
        studentId: target.studentId,
        tabRef: row.tabRef,
        status: "stale_tab_ref" as const,
      })));
      return {
        ...target,
        available: false,
        studentSessionId: null,
        deviceId: null,
        unavailableReason: "stale_tab_ref",
      };
    }
    const exactTabCloseVersion = classpilotExactTabCloseVersion(snapshot);
    if (!exactTabCloseVersion) {
      outcomes.push(...rows.map((row) => ({
        studentId: target.studentId,
        tabRef: row.tabRef,
        status: "unsupported" as const,
      })));
      return {
        ...target,
        available: false,
        studentSessionId: null,
        deviceId: null,
        unavailableReason: "exact_tab_close_unsupported",
      };
    }
    const currentRevision = snapshot.tabSnapshotRevision;
    const currentRefs = new Set(snapshot.allOpenTabs.map((tab) => tab.tabRef).filter(Boolean));
    const stale = rows.some((row) =>
      !currentRevision || row.observedRevision !== currentRevision || !currentRefs.has(row.tabRef)
    );
    outcomes.push(...rows.map((row) => ({
      studentId: target.studentId,
      tabRef: row.tabRef,
      status: (!currentRevision || row.observedRevision !== currentRevision || !currentRefs.has(row.tabRef))
        ? "stale_tab_ref" as const
        : "accepted" as const,
    })));
    return stale ? {
      ...target,
      available: false,
      studentSessionId: null,
      deviceId: null,
      unavailableReason: "stale_tab_ref",
    } : { ...target, exactTabCloseVersion };
  });
  return { targets, outcomes };
}

async function authorizeScreenOnlyUnlock(options: {
  schoolId: string;
  targets: ResolvedClasspilotCommandTarget[];
}): Promise<ResolvedClasspilotCommandTarget[]> {
  const bindings = options.targets
    .filter((target) => target.available && target.studentSessionId && target.deviceId)
    .map((target) => ({
      studentId: target.studentId,
      studentSessionId: target.studentSessionId!,
      deviceId: target.deviceId!,
  }));
  const snapshots = await readClasspilotRealtimeStatusBatch(options.schoolId, bindings);
  // A signed-out student may still carry a pending late-sign-in Waypoint.
  // Clearing that never-applied screen restriction is a desired-state update,
  // so it does not require an online extension or screenOnlyUnlockV1. Other
  // desired restrictions remain untouched by the screen-only clear.
  const offlinePendingClearIds = new Set<string>();
  for (const target of options.targets) {
    if (target.available || target.studentSessionId || target.deviceId) continue;
    if (target.stateAuthorized === false || target.lateSignInEligible !== true) continue;
    const state = await getClasspilotStudentControlState(options.schoolId, target.studentId);
    const restrictions = state
      ? normalizeClasspilotRestrictions((state.desiredState as any)?.restrictions ?? state.desiredState)
      : null;
    if (restrictions?.screenLock?.active) offlinePendingClearIds.add(target.studentId);
  }
  return options.targets.map((target) => {
    if (!target.available || !target.studentSessionId || !target.deviceId) {
      if (offlinePendingClearIds.has(target.studentId)) {
        return {
          ...target,
          unavailableReason: "screen_only_unlock_pending_clear",
        };
      }
      return {
        ...target,
        stateAuthorized: false,
        unavailableReason: "screen_only_unlock_requires_capable_online_extension",
      };
    }
    const read = snapshots.get(target.studentId);
    const snapshot = read?.status === "hit" ? read.snapshot : null;
    if (
      !snapshot ||
      !classpilotRealtimeFresh(snapshot) ||
      !new Set(snapshot.extensionCapabilities || []).has("screenOnlyUnlockV1")
    ) {
      return {
        ...target,
        available: false,
        stateAuthorized: false,
        studentSessionId: null,
        deviceId: null,
        unavailableReason: "screen_only_unlock_unsupported",
      };
    }
    return target;
  });
}

const OFFLINE_PERSISTENCE_COMMAND_TYPES = new Set([
  "lock-screen",
  "unlock-screen",
  "apply-flight-path",
  "remove-flight-path",
  "apply-block-list",
  "remove-block-list",
]);

function classpilotTargetIsOffline(target: ResolvedClasspilotCommandTarget): boolean {
  return !target.available && !target.studentSessionId && !target.deviceId;
}

async function resolveCurrentUrlLockTargets(options: {
  schoolId: string;
  targets: ResolvedClasspilotCommandTarget[];
}): Promise<{
  targets: ResolvedClasspilotCommandTarget[];
  urlByStudent: Map<string, string>;
}> {
  const bindings = options.targets
    .filter((target) => target.available && target.studentSessionId && target.deviceId)
    .map((target) => ({
      studentId: target.studentId,
      studentSessionId: target.studentSessionId!,
      deviceId: target.deviceId!,
    }));
  const snapshots = await readClasspilotRealtimeStatusBatch(options.schoolId, bindings);
  const urlByStudent = new Map<string, string>();
  const targets = options.targets.map((target) => {
    const skip = (reason: string): ResolvedClasspilotCommandTarget => ({
      ...target,
      available: false,
      stateAuthorized: false,
      studentSessionId: null,
      deviceId: null,
      unavailableReason: reason,
    });
    if (!target.available || !target.studentSessionId || !target.deviceId) {
      return target.stateAuthorized === false ? target : skip("current_page_requires_online_student");
    }
    const read = snapshots.get(target.studentId);
    const snapshot = read?.status === "hit" ? read.snapshot : null;
    const activeTabUrl = snapshot && classpilotRealtimeFresh(snapshot)
      ? String(snapshot.activeTabUrl || "")
      : "";
    if (!/^https?:\/\//i.test(activeTabUrl)) return skip("current_page_unavailable");
    urlByStudent.set(target.studentId, activeTabUrl.slice(0, 4_096));
    return target;
  });
  return { targets, urlByStudent };
}

function applyOfflineRestrictionPolicy(options: {
  schoolId: string;
  commandType: string;
  deliveryPolicy: ClasspilotCommandDeliveryPolicy;
  targets: ResolvedClasspilotCommandTarget[];
}): { targets: ResolvedClasspilotCommandTarget[]; deferredStudentIds: Set<string> } {
  const deferredStudentIds = new Set<string>();
  const gateActive = isClasspilotCapabilityActive(
    "lateSignInRestrictionSsoV1",
    { schoolId: options.schoolId }
  );
  const allowlisted = options.deliveryPolicy === "persistent_control"
    && OFFLINE_PERSISTENCE_COMMAND_TYPES.has(options.commandType);
  const targets = options.targets.map((target) => {
    if (!classpilotTargetIsOffline(target)) return target;
    if (
      target.stateAuthorized === false
      || !target.lateSignInEligible
      || !gateActive
      || !allowlisted
    ) {
      return {
        ...target,
        stateAuthorized: false,
        lateSignInEligible: false,
        unavailableReason: target.unavailableReason || "restriction_requires_online_student",
      };
    }
    deferredStudentIds.add(target.studentId);
    return target;
  });
  return { targets, deferredStudentIds };
}

function restrictionsAreEmpty(value: unknown): boolean {
  const restrictions = normalizeClasspilotRestrictions(value);
  return !restrictions.screenLock.active
    && !restrictions.flightPath.active
    && !restrictions.blockList.active
    && !restrictions.attentionMode.active
    && restrictions.tabLimit === null
    && restrictions.temporaryAllows.length === 0;
}

export function classpilotCommandFrameForTarget(
  schoolId: string,
  commandType: string,
  extensionType: string,
  payload: any,
  target: ResolvedClasspilotCommandTarget,
  delivery: {
    policy: ClasspilotCommandDeliveryPolicy;
    expiresAt: Date | null;
  },
  classroomState: ReturnType<typeof serializeClasspilotStudentControlState> | undefined,
  commandAuthority: ReturnType<typeof classpilotCommandAuthorityEnvelope>
) {
  const deliveryEnvelope = {
    deliveryPolicy: delivery.policy,
    expiresAt: delivery.expiresAt?.toISOString() || null,
  };
  // Shared Chromebooks can change student identity while a device-targeted
  // WebSocket/Redis frame is in flight. Every side-effecting envelope carries
  // the exact frozen public binding so the extension rejects a delayed frame
  // before applying it. Device ids remain transport-only.
  const bindingEnvelope = {
    studentId: target.studentId,
    studentSessionId: target.studentSessionId,
  };
  const deferredExactBindingEnvelope = classroomState?.deliveryContext?.lateSignInRestrictionSso === true
    && target.deviceId
    && target.studentSessionId
    && Number.isSafeInteger(classroomState.revision)
    ? {
        exactBinding: classpilotControlStateExactBinding({
          schoolId,
          deviceId: target.deviceId,
          studentId: target.studentId,
          studentSessionId: target.studentSessionId,
          controlRevision: classroomState.revision,
        }),
      }
    : {};
  if (commandType === "close-tabs" && Array.isArray(payload?.tabsToClose)) {
    const ownTabs = payload.tabsToClose.filter((tab: any) =>
      String(tab.studentId || "") === target.studentId
    );
    if (!payload.closeAll && ownTabs.length === 0) return null;
    const exactBindingEnvelope = target.exactTabCloseVersion === 2
      && target.deviceId
      && target.studentSessionId
      && Number.isSafeInteger(target.controlRevision)
      ? {
          exactBinding: classpilotControlStateExactBinding({
            schoolId,
            deviceId: target.deviceId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
            controlRevision: target.controlRevision!,
          }),
        }
      : {};
    if (target.exactTabCloseVersion === 2 && !("exactBinding" in exactBindingEnvelope)) {
      return null;
    }
    return {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      commandId: payload.commandId,
      ...bindingEnvelope,
      ...exactBindingEnvelope,
      ...deliveryEnvelope,
      command: {
        type: extensionType,
        commandId: payload.commandId,
        ...bindingEnvelope,
        ...exactBindingEnvelope,
        ...deliveryEnvelope,
        ...commandAuthority,
        data: {
          ...payload,
          tabsToClose: undefined,
          tabRefs: ownTabs.map((tab: any) => tab.tabRef),
          snapshotRevision: ownTabs[0]?.observedRevision,
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
      ...bindingEnvelope,
      ...deliveryEnvelope,
      ...commandAuthority,
      ...(target.durableAuthorityRevision !== undefined
        ? { ownershipRevision: target.durableAuthorityRevision }
        : {}),
      message: payload.message,
      fromName: "Teacher",
    };
  }

  return {
    type: "remote-control",
    _msgId: crypto.randomUUID(),
    commandId: payload.commandId,
    ...bindingEnvelope,
    ...deferredExactBindingEnvelope,
    ...deliveryEnvelope,
    command: {
      type: extensionType,
      commandId: payload.commandId,
      ...bindingEnvelope,
      ...deliveryEnvelope,
      ...commandAuthority,
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
  const completedStudentIds = new Set<string>();
  let cleanupFailures = 0;
  let publicationFailures = 0;

  for (const target of options.targets) {
    if (!target.deviceId || !target.studentSessionId) continue;
    if (seenSessionIds.has(target.studentSessionId)) continue;
    seenSessionIds.add(target.studentSessionId);
    let endedSession;
    try {
      endedSession = await endStudentSessionExact({
        schoolId: options.schoolId,
        studentId: target.studentId,
        studentSessionId: target.studentSessionId,
        deviceId: target.deviceId,
      });
    } catch {
      cleanupFailures += 1;
      continue;
    }
    if (!endedSession) continue;
    completedStudentIds.add(target.studentId);
    try {
      await publishClasspilotStudentSessionEnded({
        schoolId: options.schoolId,
        studentId: endedSession.studentId,
        studentSessionId: endedSession.id,
        deviceId: endedSession.deviceId,
        reason: "teacher_sign_out",
      });
    } catch {
      publicationFailures += 1;
    }
  }
  await markClasspilotCommandTargetsServerCompleted(
    options.commandId,
    [...completedStudentIds]
  );
  if (cleanupFailures > 0 || publicationFailures > 0) {
    console.warn("[ClassPilot Command] Student sign-out follow-up was incomplete", {
      cleanupFailureCount: cleanupFailures,
      publicationFailureCount: publicationFailures,
    });
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
  payloadByStudent?: Map<string, any>;
  deferredStudentIds?: Set<string>;
  bindingExpectationByStudent?: Map<string, {
    kind: "signed_out";
  } | {
    kind: "exact";
    studentSessionId: string;
    deviceId: string;
  }>;
}) {
  const targetStudentIds = options.targets.map((target) => target.studentId);
  if (targetStudentIds.length === 0) {
    return { rows: [] as ClasspilotStudentControlState[], rejectedStudentIds: [] as string[] };
  }
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
    return { rows: [] as ClasspilotStudentControlState[], rejectedStudentIds: [] as string[] };
  }
  if (!isPersistentClasspilotControl(options.commandType)) {
    return { rows: [] as ClasspilotStudentControlState[], rejectedStudentIds: [] as string[] };
  }

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
      stateTypes: options.payload.screenOnly === true
        ? ["screen-lock"]
        : ["screen-lock", "flight-path"],
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
      payload: options.payloadByStudent?.get(target.studentId) ?? options.payload,
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
      bindingExpectationByStudent: options.bindingExpectationByStudent,
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
        const effectivePayload = options.payloadByStudent?.get(studentId) ?? options.payload;
        const restrictions = applyClasspilotControlCommand(
          baseRestrictions,
          options.commandType,
          effectivePayload,
          now
        );
        if (restrictionsAreEmpty(restrictions)) return { restrictions };
        const currentDesired = current?.teachingSessionId === options.teachingSessionId
          && current.desiredState && typeof current.desiredState === "object"
          && !Array.isArray(current.desiredState)
          ? current.desiredState as Record<string, unknown>
          : {};
        const desiredState = { ...currentDesired, restrictions };
        return options.deferredStudentIds?.has(studentId)
          || readClasspilotLateSignInDeliveryProvenance(currentDesired)
          ? withClasspilotLateSignInOrigin({
              desiredState,
              commandId: options.commandId,
              createdAt: now,
            })
          : desiredState;
      },
    },
  });
  return {
    rows: result.studentControlStates,
    rejectedStudentIds: result.rejectedStudentIds,
  };
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
  payloadByStudent?: Map<string, any>;
  deferredStudentIds?: Set<string>;
  bindingExpectationByStudent?: Map<string, {
    kind: "signed_out";
  } | {
    kind: "exact";
    studentSessionId: string;
    deviceId: string;
  }>;
}) {
  const studentIds = options.targets.map((target) => target.studentId);
  return replaceClasspilotSupervisionControlSnapshots({
    schoolId: options.schoolId,
    supervisionContextId: options.supervisionContextId,
    studentIds,
    sourceCommandId: options.commandId,
    authorizedActorId: options.actorId,
    actorIsAdmin: options.actorIsAdmin,
    bindingExpectationByStudent: options.bindingExpectationByStudent,
    desiredState: (studentId: string, current: ClasspilotStudentControlState | null) => {
      const currentDesired = current?.supervisionContextId === options.supervisionContextId
        && current.desiredState && typeof current.desiredState === "object"
        && !Array.isArray(current.desiredState)
        ? current.desiredState as Record<string, unknown>
        : {};
      const baseRestrictions = current?.supervisionContextId === options.supervisionContextId
        ? normalizeClasspilotRestrictions((current.desiredState as any)?.restrictions ?? current.desiredState)
        : emptyClasspilotRestrictions();
      const restrictions = applyClasspilotControlCommand(
        baseRestrictions,
        options.commandType,
        options.payloadByStudent?.get(studentId) ?? options.payload
      );
      if (restrictionsAreEmpty(restrictions)) {
        // Clearing Coverage's own pending restriction removes its top-level
        // deferred stamp, but the nested pre-Coverage class snapshot must stay
        // intact so release cannot reconstruct formerly deferred state ungated.
        const { lateSignInDelivery: _clearedCoverageOrigin, ...preserved } = currentDesired;
        return { ...preserved, restrictions };
      }
      const desiredState = { ...currentDesired, restrictions };
      return options.deferredStudentIds?.has(studentId)
        || readClasspilotLateSignInDeliveryProvenance(currentDesired)
        ? withClasspilotLateSignInOrigin({
            desiredState,
            commandId: options.commandId,
          })
        : desiredState;
    },
  }).then((rows) => ({
    rows,
    rejectedStudentIds: studentIds.filter((studentId) =>
      !rows.some((row) => row.studentId === studentId)
    ),
  }));
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
  // Poll close is bound to the immutable start-command target rows. Dashboard
  // selection is presentation state and must never widen, narrow, or redirect
  // the students whose poll overlay is being closed.
  const authoritativeRequestedTargets = normalized.extra?.pollCloseAuthority?.targets
    ?? options.targets;
  const exactTabAuthorization = options.commandType === "close-tabs"
    ? await authorizeExactTabClose({
        schoolId: options.schoolId,
        payload: commandPayload,
        targets: authoritativeRequestedTargets,
      })
    : { targets: authoritativeRequestedTargets, outcomes: [] as ExactTabOutcome[] };
  const effectiveTargets = options.commandType === "unlock-screen" && commandPayload.screenOnly === true
    ? await authorizeScreenOnlyUnlock({
        schoolId: options.schoolId,
        targets: exactTabAuthorization.targets,
      })
    : exactTabAuthorization.targets;
  const issuedAt = new Date();
  const deliveryPolicy = classpilotCommandDeliveryPolicy(options.commandType);
  const expiresAt = classpilotCommandExpiresAt(options.commandType, issuedAt);
  const currentPageRequested = options.commandType === "lock-screen"
    && commandPayload.url === "CURRENT_URL";
  const currentUrlResolution = currentPageRequested
    ? await resolveCurrentUrlLockTargets({
        schoolId: options.schoolId,
        targets: effectiveTargets,
      })
    : null;
  const offlinePolicy = applyOfflineRestrictionPolicy({
    schoolId: options.schoolId,
    commandType: options.commandType,
    deliveryPolicy,
    targets: currentUrlResolution?.targets ?? effectiveTargets,
  });
  const policyTargets = offlinePolicy.targets;
  const payloadByStudent = currentUrlResolution
    ? new Map([...currentUrlResolution.urlByStudent].map(([studentId, url]) => [
        studentId,
        { ...commandPayload, url },
      ]))
    : undefined;
  const bindingExpectationByStudent = new Map<string,
    { kind: "signed_out" } | {
      kind: "exact";
      studentSessionId: string;
      deviceId: string;
    }>();
  for (const target of policyTargets) {
    if (target.stateAuthorized === false) continue;
    if (target.lateSignInEligible) {
      bindingExpectationByStudent.set(target.studentId, { kind: "signed_out" });
    } else if (target.studentSessionId && target.deviceId) {
      bindingExpectationByStudent.set(target.studentId, {
        kind: "exact",
        studentSessionId: target.studentSessionId,
        deviceId: target.deviceId,
      });
    }
  }
  // CURRENT_URL is an input sentinel, never durable command state. Only the
  // per-exact-binding concrete URL is persisted in that student's snapshot.
  const storedCommandPayload = currentPageRequested
    ? Object.fromEntries(Object.entries(commandPayload).filter(([key]) => key !== "url"))
    : commandPayload;
  if (currentPageRequested) storedCommandPayload.currentPage = true;

  const created = await createClasspilotCommandWithTargets(
    {
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId || null,
      supervisionContextId: options.supervisionContextId || null,
      teacherId: options.actorId,
      targetScope: normalized.extra?.pollCloseAuthority
        ? normalized.extra.pollCloseAuthority.targetScope
        : options.targetScope,
      subgroupId: normalized.extra?.pollCloseAuthority
        ? normalized.extra.pollCloseAuthority.subgroupId
        : options.subgroupId || null,
      commandType: options.commandType,
      commandPayload: storedCommandPayload,
      requestedCount: policyTargets.length,
      unavailableCount: policyTargets.filter((target) => !target.available).length,
      expiresAt,
    },
    policyTargets.map((target) => ({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId || null,
      supervisionContextId: options.supervisionContextId || null,
      commandId: "",
      studentId: target.studentId,
      studentSessionId: target.studentSessionId,
      deviceId: target.deviceId,
      status: target.available ? "requested" : "unavailable",
      errorMessage: target.available ? null : target.unavailableReason || "Student unavailable",
      result: target.exactTabCloseVersion === 2
        ? { exactTabCloseVersion: 2 }
        : null,
    })),
    {
      authority: options.teachingSessionId ? {
        schoolId: options.schoolId,
        actorId: options.actorId,
        teachingSessionId: options.teachingSessionId,
      } : options.supervisionContextId ? {
        schoolId: options.schoolId,
        actorId: options.actorId,
        supervisionContextId: options.supervisionContextId,
        actorMayUseAdminAuthority: options.supervisionActorIsAdmin === true,
      } : undefined,
      pollMutation: normalized.extra?.pollMutation,
    }
  );
  const committedCommandPayload = created.commandPayload
    && typeof created.commandPayload === "object"
    && !Array.isArray(created.commandPayload)
    ? created.commandPayload as Record<string, unknown>
    : storedCommandPayload;

  const committedTargetByStudent = new Map(
    created.targets.map((target) => [target.studentId, target])
  );
  let committedTargets = policyTargets.map((target) => {
    const persisted = committedTargetByStudent.get(target.studentId);
    if (!persisted) {
      return {
        ...target,
        available: false,
        stateAuthorized: false,
        studentSessionId: null,
        deviceId: null,
        unavailableReason: "Command target was not committed",
      };
    }
    const authorityChanged = persisted.errorMessage?.includes("authority changed before dispatch") === true;
    return {
      ...target,
      studentSessionId: persisted.studentSessionId,
      deviceId: persisted.deviceId,
      available: persisted.status !== "unavailable",
      stateAuthorized: authorityChanged ? false : target.stateAuthorized,
      unavailableReason: persisted.errorMessage || target.unavailableReason,
      durableAuthorityRevision:
        persisted.result
        && typeof persisted.result === "object"
        && !Array.isArray(persisted.result)
        && Number.isSafeInteger((persisted.result as Record<string, unknown>).durableAuthorityRevision)
          ? Number((persisted.result as Record<string, unknown>).durableAuthorityRevision)
          : undefined,
      controlRevision:
        persisted.result
        && typeof persisted.result === "object"
        && !Array.isArray(persisted.result)
        && Number.isSafeInteger((persisted.result as Record<string, unknown>).frozenControlRevision)
          ? Number((persisted.result as Record<string, unknown>).frozenControlRevision)
          : undefined,
    };
  });

  const exactV2StudentIds = committedTargets
    .filter((target) => target.available && target.exactTabCloseVersion === 2)
    .map((target) => target.studentId);
  if (exactV2StudentIds.length > 0) {
    const revalidated = await revalidateClasspilotExactCommandTargetsForDispatch({
      schoolId: options.schoolId,
      commandId: created.id,
      studentIds: exactV2StudentIds,
    });
    const revalidatedByStudent = new Map(revalidated.map((target) => [target.studentId, target]));
    committedTargets = committedTargets.map((target) => {
      if (target.exactTabCloseVersion !== 2) return target;
      const persisted = revalidatedByStudent.get(target.studentId);
      if (!persisted || persisted.status === "unavailable") {
        return {
          ...target,
          available: false,
          stateAuthorized: false,
          unavailableReason: persisted?.errorMessage || "Exact tab authority changed before dispatch",
        };
      }
      return target;
    });
  }

  const shouldPersistBeforeDelivery = deliveryPolicy === "persistent_control";
  const stateAuthorizedTargets = committedTargets.filter((target) => target.stateAuthorized !== false);
  const durableMessageIdByStudent = new Map<string, string>();
  if (deliveryPolicy === "durable_message") {
    // The pending-message inbox is the durable authority. Persist once for
    // every authorized selected student even if no live device is reachable.
    for (const target of stateAuthorizedTargets) {
      const message = await createMessage({
        fromUserId: options.actorId,
        toStudentId: target.studentId,
        commandId: created.id,
        teachingSessionId: created.teachingSessionId,
        supervisionContextId: created.supervisionContextId,
        message: commandPayload.message,
        isAnnouncement: false,
      }, options.schoolId);
      durableMessageIdByStudent.set(target.studentId, message.id);
    }
  }
  const persistence = shouldPersistBeforeDelivery
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
        payloadByStudent,
        deferredStudentIds: offlinePolicy.deferredStudentIds,
        bindingExpectationByStudent,
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
          payloadByStudent,
          deferredStudentIds: offlinePolicy.deferredStudentIds,
          bindingExpectationByStudent,
        })
    : { rows: [] as ClasspilotStudentControlState[], rejectedStudentIds: [] as string[] };
  if (persistence.rejectedStudentIds.length > 0) {
    await markClasspilotCommandTargetsUnavailable(
      created.id,
      persistence.rejectedStudentIds
    );
    const rejected = new Set(persistence.rejectedStudentIds);
    committedTargets = committedTargets.map((target) => rejected.has(target.studentId)
      ? {
          ...target,
          available: false,
          stateAuthorized: false,
          studentSessionId: null,
          deviceId: null,
          unavailableReason: "Student binding changed before desired state was persisted",
        }
      : target
    );
  }
  const controlStateRows = persistence.rows;
  const deferredRows = controlStateRows.filter((row) =>
    readClasspilotLateSignInDeliveryProvenance(row.desiredState)
  );
  const createdDeferredCount = deferredRows.filter((row) =>
    offlinePolicy.deferredStudentIds.has(row.studentId)
  ).length;
  if (createdDeferredCount > 0) {
    recordHeartbeatHotPathCounter("lateSignInDeferredCreated", createdDeferredCount);
  }
  const deferredIds = new Set(deferredRows.map((row) => row.studentId));
  const deferredRealtime = deferredRows.length > 0
    ? await readClasspilotRealtimeStatusBatch(
        options.schoolId,
        committedTargets.filter((target) =>
          deferredIds.has(target.studentId)
          && target.available
          && target.studentSessionId
          && target.deviceId
        ).map((target) => ({
          studentId: target.studentId,
          studentSessionId: target.studentSessionId!,
          deviceId: target.deviceId!,
        }))
      )
    : new Map();
  const gateActive = isClasspilotCapabilityActive(
    "lateSignInRestrictionSsoV1",
    { schoolId: options.schoolId }
  );
  const targetByStudent = new Map(committedTargets.map((target) => [target.studentId, target]));
  const classroomStateByStudent = new Map(controlStateRows.flatMap((row) => {
    const target = targetByStudent.get(row.studentId);
    const read = deferredRealtime.get(row.studentId);
    const snapshot = read?.status === "hit" && classpilotRealtimeFresh(read.snapshot)
      ? read.snapshot
      : null;
    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state: row,
      gateActive,
      acceptedCapabilities: snapshot?.acceptedCapabilities ?? [],
      exactBinding: target?.studentSessionId && target.deviceId
        ? {
            schoolId: options.schoolId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
            deviceId: target.deviceId,
          }
        : null,
    });
    if (delivered.withheld) {
      recordHeartbeatHotPathCounter("lateSignInDeliveryWithheld");
    } else if (delivered.classroomState?.deliveryContext?.lateSignInRestrictionSso) {
      recordHeartbeatHotPathCounter("lateSignInCapableDelivery");
    }
    return delivered.classroomState ? [[row.studentId, delivered.classroomState] as const] : [];
  }));
  // Delivery authority is copied from the transactionally persisted command
  // header. It must never be recomputed from mutable dashboard selection state.
  const commandAuthority = classpilotCommandAuthorityEnvelope(created);

  const sentTargets: ResolvedClasspilotCommandTarget[] = [];
  const deliveryCandidates: ResolvedClasspilotCommandTarget[] = [];
  const remotePublications: PublishWSBatchItem[] = [];
  const localDeliveryStartedAt = performance.now();
  let localDeliverySucceeded = false;
  try {
    for (const target of committedTargets.filter((target) => target.available && target.deviceId)) {
      // A durable row that still carries deferred origin must never fall back
      // to the raw legacy command envelope. That would bypass the same
      // capability gate that withheld its authoritative snapshot.
      if (deferredIds.has(target.studentId) && !classroomStateByStudent.has(target.studentId)) {
        continue;
      }
      const message = classpilotCommandFrameForTarget(options.schoolId, options.commandType, normalized.extensionType, {
        ...committedCommandPayload,
        ...(payloadByStudent?.get(target.studentId)?.url
          ? { url: payloadByStudent.get(target.studentId)!.url, currentPage: undefined }
          : {}),
        commandId: created.id,
        messageId: durableMessageIdByStudent.get(target.studentId),
      }, target, {
        policy: deliveryPolicy,
        expiresAt,
      }, classroomStateByStudent.get(target.studentId), commandAuthority);
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
      payloadByStudent,
      deferredStudentIds: offlinePolicy.deferredStudentIds,
      bindingExpectationByStudent,
    });
  }
  const command = await getClasspilotCommandByIdAndSchool(created.id, options.schoolId);
  if (!command) throw Object.assign(new Error("Command was created but could not be loaded"), { status: 500 });
  const targetOrder = new Map(policyTargets.map((target, index) => [target.studentId, index]));
  command.targets.sort((left, right) =>
    (targetOrder.get(left.studentId) ?? Number.MAX_SAFE_INTEGER)
    - (targetOrder.get(right.studentId) ?? Number.MAX_SAFE_INTEGER)
  );
  const summary = commandSummary(command);
  // Internal poll mutation/authority metadata includes exact binding rows and
  // must never cross the teacher API boundary. Preserve the established public
  // `extra.poll` response using only the persisted poll resource.
  const responseExtra = normalized.extra?.pollMutation
    ? {
        poll: await getPollById(
          normalized.extra.pollMutation.pollId,
          options.schoolId
        ),
      }
    : null;
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
    ...(exactTabAuthorization.outcomes.length > 0
      ? { tabOutcomes: exactTabAuthorization.outcomes }
      : {}),
    ...(currentPageRequested
      ? {
          skippedCurrentPageCount: countClasspilotCurrentPageSignedOutSkips(policyTargets),
        }
      : {}),
    extra: responseExtra,
  };
}
