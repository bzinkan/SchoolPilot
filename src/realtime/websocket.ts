import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "http";
import { randomUUID } from "crypto";
import { safeErrorMetadata } from "../util/safeLogging.js";
import {
  isClasspilotCapabilityActive,
  negotiateClasspilotSurfaceProtocol,
} from "../services/classpilotProtocol.js";
import {
  InvalidTokenError,
  TokenExpiredError,
  verifyStudentToken,
  type StudentTokenPayload,
} from "../services/deviceJwt.js";
import { credentialVersionMatches, verifyUserToken } from "../services/jwt.js";
import errorMonitor from "../services/errorMonitor.js";
import {
  registerWsClient,
  getWsClient,
  closeStaffUserSocketsLocal,
  removeWsClient,
  authenticateWsClient,
  broadcastToTeachersLocal,
  broadcastToStaffSessionLocal,
  broadcastToStudentsLocal,
  sendToDeviceLocal,
  sendToStudentBindingLocal,
  sendToStaffUserLocal,
  sendToRoleLocal,
  subscribeWsClientToSession,
  unsubscribeWsClientFromSession,
  closeStudentSocketsLocal,
  type WSClient,
  type WsRole,
} from "./ws-broadcast.js";
import {
  publishWS,
  publishOrderedWS,
  subscribeWS,
  isRedisPublisherReady,
  recordCommandHotPathPhase,
  recordLocalOrderedDelivery,
  type WsRedisTarget,
} from "./ws-redis.js";
import {
  getSettingsForSchool,
  getUserById,
  getMembershipByUserAndSchool,
  updateClasspilotCommandSummary,
  withClasspilotCommandBroadcastLock,
  persistClasspilotCommandTargetAck,
  getTeachingSessionByIdAndSchool,
  isAuthorizedClasspilotSessionStaff,
  withClasspilotTeachingTelemetryAuthority,
  getAuthorizedClasspilotSessionStaffIds,
  getClasspilotStudentControlState,
  getClasspilotSsoPolicyForSchool,
  lockClasspilotSsoPolicyDeliveryAuthority,
  getClasspilotScreenshotAuthorityProjection,
  getActiveSessionsForStudents,
  acknowledgeClasspilotStudentControlState,
  acknowledgeTeacherChatDelivery,
  withClasspilotStudentControlDeliveryAuthority,
  withClasspilotStudentWebSocketBootstrapAuthority,
} from "../services/storage.js";
import {
  classpilotCommandAckReceipt,
  terminalClasspilotCommandAckReceipt,
} from "../services/classpilotAckReceipt.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  resolveActiveStudentTokenSession,
  studentAuthenticationServiceError,
  type ActiveStudentTokenSession,
} from "../services/classpilotStudentAuth.js";
import { buildStudentFabState } from "../services/classpilotFab.js";
import {
  broadcastScheduledClassUpdate,
  startActiveScheduledClassesForTeacher,
} from "../services/classpilotScheduledStart.js";
import { isClassPilotWebSocketPath, isGoPilotSocketIoPath } from "./websocketPaths.js";
import {
  classpilotStaffPresenceStore,
  removeClasspilotStaffPresence,
  touchClasspilotStaffPresence,
  type ClasspilotStaffPresenceStore,
} from "./classpilotStaffPresence.js";
import {
  classpilotControlStateHasAuthRelevantRestriction,
  classpilotControlStateHasLateSignInOrigin,
  classpilotLateSignInRevisionAppliedToBinding,
  classpilotRestrictionAuthProjectionRevision,
  serializeClasspilotStudentControlStateForDelivery,
} from "../services/classpilotClassroomState.js";
import { classpilotControlStateAckRequired } from "../services/classpilotControlStateAckGate.js";
import { recordHeartbeatHotPathCounter } from "../services/heartbeatHotPathMetrics.js";
import {
  classpilotClassroomStatePushFrame,
  classpilotControlStateExactBinding,
} from "../services/classpilotControlStateFrame.js";
import { publicClasspilotCommand } from "../services/classpilotCommandPublic.js";
import {
  classpilotCommandDeliveryPolicy,
  summarizeClasspilotCommandTargets,
} from "../services/classpilotCommandDelivery.js";
import {
  assertClasspilotEntitled,
  resolveClasspilotEntitlement,
} from "../services/classpilotEntitlement.js";
import { registerClasspilotCommandUpdateScheduler } from "../services/classpilotCommandUpdateScheduler.js";
import {
  classpilotAckAppliedAuthPolicyRevision,
  classpilotAckControlRevision,
  classpilotAckEnvelopeMatchesBinding,
} from "../services/classpilotAckBinding.js";
import {
  CLASSPILOT_WS_MAX_PAYLOAD_BYTES,
  normalizeClasspilotSignalingIdentifier,
  sanitizeClasspilotSignalingMessage,
} from "../services/classpilotSignaling.js";
import {
  CLASSPILOT_WS_MAX_PENDING_FRAMES,
  CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS,
  claimClasspilotLiveViewNegotiation,
  classpilotLiveViewNegotiationAuthority,
  classpilotLiveViewRequester,
  consumeClasspilotWsFrame,
  createClasspilotWsFrameBucket,
  releaseClasspilotLiveViewNegotiation,
  verifyClasspilotLiveViewNegotiation,
} from "../services/classpilotLiveViewNegotiation.js";
import { stopActiveClasspilotLiveViewNegotiations } from "../services/classpilotLiveViewStop.js";
import { resolveClasspilotStaffWebSocketAuthorization } from "../services/classpilotWebSocketAuthorization.js";
import { registerCacheInvalidationHandler } from "./cacheInvalidation.js";
import {
  classpilotScreenshotAuthorityForDeliveredControl,
  resolveClasspilotScreenshotPolicy,
} from "../services/classpilotScreenshotPolicy.js";
import {
  classpilotObservationStatus,
  type ClasspilotObservationStatus,
} from "../services/classpilotObservationLease.js";
import {
  beginClasspilotSessionSubscriptionMutation,
  isCurrentClasspilotSessionSubscriptionMutation,
  parseClasspilotSessionSubscription,
} from "../services/classpilotSessionSubscription.js";

// Ping/pong keepalive constants
const WS_PING_INTERVAL_MS = 30_000; // 30 seconds
const WS_PONG_TIMEOUT_MS = 10_000;  // 10 seconds to respond
export const CLASSPILOT_PASSIVE_AUTH_TTL_MS = 30_000;
const MAX_PASSIVE_AUTH_SCHOOLS = 4_096;
const MAX_PASSIVE_AUTH_INFLIGHT = 4_096;

/**
 * Redis can deliver an exact-binding envelope after the publishing task has
 * released its transaction lock. Recheck durable authority on the receiving
 * task and perform the local send while that same lock is held; socket-local
 * binding metadata alone can describe a retired same-device session.
 */
export async function deliverClasspilotStudentBindingRedisMessage(
  target: Extract<WsRedisTarget, { kind: "student-binding" }>,
  message: unknown
): Promise<boolean> {
  try {
    return await runWithTenantContext({ schoolId: target.schoolId }, async () => {
      const delivery = await withClasspilotStudentControlDeliveryAuthority(
        target,
        () => undefined,
        () => sendToStudentBindingLocal(target, message, {
          requiredCapability: target.requiredCapability,
          requiredCapabilities: target.requiredCapabilities,
        })
      );
      return delivery.authorized && delivery.value;
    });
  } catch (error) {
    console.warn(
      "[Redis] Exact student-binding delivery revalidation failed",
      safeErrorMetadata(error)
    );
    return false;
  }
}

type PassiveAuthorizationDecision = {
  authorized: boolean;
  /**
   * Absolute database-provided authority boundary for a manual student
   * session. Null means this authority is not lease-bound (staff, legacy, or
   * managed-profile student sessions).
   */
  authorityExpiresAtMs: number | null;
};

const passiveAuthorizationGenerationBySchool = new Map<string, number>();
const passiveAuthorizationInflight = new Map<
  string,
  Promise<PassiveAuthorizationDecision>
>();

function passiveAuthorizationGeneration(schoolId: string): number {
  return passiveAuthorizationGenerationBySchool.get(schoolId) ?? 0;
}

export function invalidatePassiveWebSocketAuthorizationLocal(schoolId: string): void {
  const next = passiveAuthorizationGeneration(schoolId) + 1;
  passiveAuthorizationGenerationBySchool.delete(schoolId);
  passiveAuthorizationGenerationBySchool.set(schoolId, next);
  if (passiveAuthorizationGenerationBySchool.size > MAX_PASSIVE_AUTH_SCHOOLS) {
    const oldest = passiveAuthorizationGenerationBySchool.keys().next().value;
    if (oldest) passiveAuthorizationGenerationBySchool.delete(oldest);
  }
}

registerCacheInvalidationHandler((target) => {
  if (target.cache === "classpilot-passive-authorization") {
    invalidatePassiveWebSocketAuthorizationLocal(target.schoolId);
  } else if (target.cache === "user-credentials") {
    closeStaffUserSocketsLocal(target.userId);
  }
});

export function hasFreshPassiveWebSocketAuthorization(
  client: Pick<
    WSClient,
    "schoolId" | "passiveAuthorizationExpiresAt" | "passiveAuthorizationGeneration"
  >,
  now = Date.now()
): boolean {
  return Boolean(
    client.schoolId &&
    client.passiveAuthorizationExpiresAt &&
    client.passiveAuthorizationExpiresAt > now &&
    client.passiveAuthorizationGeneration === passiveAuthorizationGeneration(client.schoolId)
  );
}

/**
 * Student authority is exact and lifecycle-sensitive, so even otherwise
 * harmless pong/ping/heartbeat frames must use a fresh database check. Staff
 * passive frames retain the bounded cache to avoid unnecessary membership
 * reads while invalidation remains immediate.
 */
export function mayUsePassiveWebSocketAuthorizationCache(role: WsRole): boolean {
  return role !== "student";
}

export function rememberPassiveWebSocketAuthorization(
  client: Pick<
    WSClient,
    "schoolId" | "passiveAuthorizationExpiresAt" | "passiveAuthorizationGeneration"
  >,
  authorityExpiresAtMs: number | null,
  now = Date.now()
): void {
  if (!client.schoolId) return;
  client.passiveAuthorizationGeneration = passiveAuthorizationGeneration(client.schoolId);
  const ttlExpiresAt = now + CLASSPILOT_PASSIVE_AUTH_TTL_MS;
  client.passiveAuthorizationExpiresAt = authorityExpiresAtMs === null
    ? ttlExpiresAt
    : Math.min(ttlExpiresAt, authorityExpiresAtMs);
}

async function singleFlightPassiveAuthorization(
  key: string,
  load: () => Promise<PassiveAuthorizationDecision>
): Promise<{
  decision: PassiveAuthorizationDecision;
  joined: boolean;
  bypassed: boolean;
}> {
  const existing = passiveAuthorizationInflight.get(key);
  if (existing) return { decision: await existing, joined: true, bypassed: false };
  if (passiveAuthorizationInflight.size >= MAX_PASSIVE_AUTH_INFLIGHT) {
    return { decision: await load(), joined: false, bypassed: true };
  }
  const pending = load().finally(() => {
    if (passiveAuthorizationInflight.get(key) === pending) {
      passiveAuthorizationInflight.delete(key);
    }
  });
  passiveAuthorizationInflight.set(key, pending);
  return { decision: await pending, joined: false, bypassed: false };
}

function emitWebSocketMetric(metricName: "WebSocketDisconnect" | "WebSocketError") {
  const environment = process.env.APP_ENV || process.env.NODE_ENV || "development";
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/WebSocket",
        Dimensions: [["Environment", "Service"]],
        Metrics: [{ Name: metricName, Unit: "Count" }],
      }],
    },
    Environment: environment,
    Service: "api",
    [metricName]: 1,
  }));
}

type StudentWebSocketSessionResolver = (
  payload: StudentTokenPayload
) => Promise<ActiveStudentTokenSession | undefined>;

const defaultStudentWebSocketSessionResolver: StudentWebSocketSessionResolver = (payload) =>
  runWithTenantContext({ schoolId: payload.schoolId }, () =>
    resolveActiveStudentTokenSession(payload)
  );

/**
 * Revalidate the exact persisted student/session/device binding for an already
 * authenticated socket. Student lifecycle changes end the persisted session;
 * checking it again before every student-originating message prevents a socket
 * that was open during roster removal from acknowledging commands, mutating
 * chat delivery, or sending WebRTC signaling afterward.
 */
async function resolveActiveStudentWebSocketAuthorization(
  client: Pick<
    WSClient,
    "role" | "schoolId" | "studentId" | "studentSessionId" | "deviceId"
  >,
  resolveSession: StudentWebSocketSessionResolver = defaultStudentWebSocketSessionResolver
): Promise<PassiveAuthorizationDecision> {
  if (client.role !== "student") {
    return { authorized: true, authorityExpiresAtMs: null };
  }
  if (
    !client.schoolId ||
    !client.studentId ||
    !client.studentSessionId ||
    !client.deviceId
  ) {
    return { authorized: false, authorityExpiresAtMs: null };
  }
  const active = await resolveSession({
    schoolId: client.schoolId,
    studentId: client.studentId,
    sessionId: client.studentSessionId,
    deviceId: client.deviceId,
  });
  if (!active) return { authorized: false, authorityExpiresAtMs: null };

  // Unit callers may inject a binding resolver; production uses the default
  // path and additionally revalidates school + license on every message/pong.
  if (resolveSession !== defaultStudentWebSocketSessionResolver) {
    return { authorized: true, authorityExpiresAtMs: null };
  }
  const entitled = (await runWithTenantContext(
    { schoolId: client.schoolId },
    () => resolveClasspilotEntitlement(client.schoolId!)
  )).entitled;
  if (!entitled) {
    return { authorized: false, authorityExpiresAtMs: null };
  }
  return { authorized: true, authorityExpiresAtMs: null };
}

export async function hasActiveStudentWebSocketBinding(
  client: Pick<
    WSClient,
    "role" | "schoolId" | "studentId" | "studentSessionId" | "deviceId"
  >,
  resolveSession: StudentWebSocketSessionResolver = defaultStudentWebSocketSessionResolver
): Promise<boolean> {
  return (await resolveActiveStudentWebSocketAuthorization(client, resolveSession)).authorized;
}

type StaffMembershipResolver = (
  userId: string,
  schoolId: string
) => Promise<{ role: string } | undefined>;

type StaffEntitlementResolver = (
  schoolId: string
) => Promise<{ entitled: boolean }>;

const defaultStaffEntitlementResolver: StaffEntitlementResolver = (schoolId) =>
  runWithTenantContext({ schoolId }, () => resolveClasspilotEntitlement(schoolId));

function staffWebSocketRole(membershipRole: string): Exclude<WsRole, "student"> | null {
  if (membershipRole === "admin" || membershipRole === "school_admin") return "school_admin";
  if (membershipRole === "teacher") return "teacher";
  if (membershipRole === "office_staff") return "office_staff";
  return null;
}

/**
 * Revalidate both the school entitlement and current membership before
 * retaining staff authority. Super-admin is a user authorization bypass, not
 * a product-entitlement bypass: a disabled/unlicensed school must not retain a
 * live ClassPilot control channel for any role.
 */
export async function activeStaffWebSocketRole(
  client: Pick<WSClient, "role" | "schoolId" | "userId">,
  resolveMembership: StaffMembershipResolver = getMembershipByUserAndSchool,
  resolveEntitlement: StaffEntitlementResolver = defaultStaffEntitlementResolver
): Promise<Exclude<WsRole, "student"> | null> {
  if (!client.schoolId || !client.userId || client.role === "student") return null;
  if (
    resolveMembership === getMembershipByUserAndSchool &&
    resolveEntitlement === defaultStaffEntitlementResolver
  ) {
    return resolveClasspilotStaffWebSocketAuthorization({
      schoolId: client.schoolId,
      userId: client.userId,
      isSuperAdmin: client.role === "super_admin",
    });
  }
  if (!(await resolveEntitlement(client.schoolId)).entitled) return null;
  if (client.role === "super_admin") return "super_admin";
  const membership = await resolveMembership(client.userId, client.schoolId);
  return membership ? staffWebSocketRole(membership.role) : null;
}

export function setupWebSocket(
  httpServer: Server,
  options: { presenceStore?: ClasspilotStaffPresenceStore } = {}
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: CLASSPILOT_WS_MAX_PAYLOAD_BYTES,
  });
  const presenceStore = options.presenceStore ?? classpilotStaffPresenceStore;

  let activity = {
    connected: 0,
    studentAuthenticated: 0,
    staffAuthenticated: 0,
    passiveAuthorizationCacheHits: 0,
    passiveAuthorizationLoads: 0,
    passiveAuthorizationJoins: 0,
    passiveAuthorizationBypasses: 0,
    passiveAuthorizationDenied: 0,
  };
  const activityTimer = setInterval(() => {
    const snapshot = activity;
    activity = {
      connected: 0,
      studentAuthenticated: 0,
      staffAuthenticated: 0,
      passiveAuthorizationCacheHits: 0,
      passiveAuthorizationLoads: 0,
      passiveAuthorizationJoins: 0,
      passiveAuthorizationBypasses: 0,
      passiveAuthorizationDenied: 0,
    };
    if (
      snapshot.connected === 0 &&
      snapshot.studentAuthenticated === 0 &&
      snapshot.staffAuthenticated === 0 &&
      snapshot.passiveAuthorizationLoads === 0
    ) return;
    console.log(JSON.stringify({
      type: "websocket_activity",
      intervalSeconds: 60,
      ...snapshot,
    }));
  }, 60_000);
  activityTimer.unref();
  wss.once("close", () => clearInterval(activityTimer));

  // Track ping/pong state per client
  const clientPingTimers = new Map<WebSocket, NodeJS.Timeout>();
  const clientPongTimers = new Map<WebSocket, NodeJS.Timeout>();
  const clientPongPending = new Map<WebSocket, boolean>();
  const MAX_CONCURRENT_COMMAND_UPDATE_PUBLICATIONS = 2;
  const COMMAND_UPDATE_PUBLISH_TIMEOUT_MS = 1_500;
  type CommandUpdateState = {
    key: string;
    schoolId: string;
    commandId: string;
    timer: NodeJS.Timeout | null;
    queued: boolean;
    inFlight: boolean;
    dirty: boolean;
    retryCount: number;
  };
  const commandUpdateStates = new Map<string, CommandUpdateState>();
  const commandUpdateQueue: CommandUpdateState[] = [];
  let activeCommandUpdatePublications = 0;
  let commandUpdateQueueClosed = false;

  const armCommandUpdate = (state: CommandUpdateState) => {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (commandUpdateQueueClosed || state.queued || state.inFlight) return;
      state.queued = true;
      commandUpdateQueue.push(state);
      drainCommandUpdates();
    }, 50);
    state.timer.unref();
  };

  const publishCommandUpdate = async (state: CommandUpdateState) => {
    await runWithTenantContext({ schoolId: state.schoolId }, async () => {
      // ACK handlers update only their target row. The existing 50 ms dirty
      // window coalesces a burst into one summary aggregation before a complete
      // revisioned snapshot is read and broadcast.
      const summaryStartedAt = performance.now();
      let summarySucceeded = false;
      try {
        await updateClasspilotCommandSummary(state.commandId);
        summarySucceeded = true;
      } finally {
        recordCommandHotPathPhase(
          "ack_summary_refresh",
          performance.now() - summaryStartedAt,
          { success: summarySucceeded }
        );
      }

      const snapshotStartedAt = performance.now();
      let snapshotSucceeded = false;
      try {
        await withClasspilotCommandBroadcastLock(state.commandId, state.schoolId, async (command, revision) => {
          const payload = {
            type: "classpilot-command-update",
            commandId: state.commandId,
            command: publicClasspilotCommand(command),
            deliveryPolicy: classpilotCommandDeliveryPolicy(command.commandType),
            expiresAt: command.expiresAt,
            summary: summarizeClasspilotCommandTargets(command),
          };
          const staffTarget: WsRedisTarget = command.teachingSessionId
            ? {
                kind: "staff-session",
                schoolId: state.schoolId,
                sessionId: command.teachingSessionId,
              }
            : {
                kind: "staff-user",
                schoolId: state.schoolId,
                userId: command.teacherId,
              };
          if (!isRedisPublisherReady()) {
            throw new Error("Ordered ClassPilot command publication requires Redis");
          }

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), COMMAND_UPDATE_PUBLISH_TIMEOUT_MS);
          timeout.unref();
          const redisStartedAt = performance.now();
          let redisSucceeded = false;
          try {
            // Redis makes the cross-task ordering decision before any local
            // fan-out. A delayed callback on another API task therefore cannot
            // deliver an older snapshot locally and only then be rejected by
            // the global revision watermark.
            const outcome = await publishOrderedWS(
              staffTarget,
              payload,
              {
                includeSource: false,
                signal: controller.signal,
                orderedKey: state.key,
                revision,
              }
            );
            if (outcome.status === "failed") {
              throw new Error("Ordered ClassPilot command publication failed");
            }
            if (
              outcome.status === "accepted" &&
              recordLocalOrderedDelivery(state.key, revision)
            ) {
              if (staffTarget.kind === "staff-session") {
                broadcastToStaffSessionLocal(state.schoolId, staffTarget.sessionId, payload);
              } else {
                sendToStaffUserLocal(state.schoolId, staffTarget.userId, payload);
              }
            }
            if (
              outcome.status === "accepted" &&
              outcome.subscriberCount === 0
            ) {
              // The global watermark is valid and source-local teachers have
              // the snapshot, but no Redis subscriber could receive it. Mark
              // this attempt failed so the bounded scheduler reads a fresh
              // revision and republishes after subscribers reconnect.
              throw new Error(
                "Ordered ClassPilot command publication had no subscribers"
              );
            }
            if (outcome.status === "stale") {
              // Redis pub/sub is intentionally non-durable. This process may
              // have missed the newer publication while its subscriber was
              // reconnecting, so read a fresh snapshot/revision on the bounded
              // retry instead of assuming its local teachers are current.
              throw new Error(
                "Ordered ClassPilot command publication was superseded"
              );
            }
            state.retryCount = 0;
            redisSucceeded = true;
          } finally {
            clearTimeout(timeout);
            recordCommandHotPathPhase(
              "ack_redis_publish",
              performance.now() - redisStartedAt,
              { success: redisSucceeded }
            );
          }
        });
        snapshotSucceeded = true;
      } finally {
        recordCommandHotPathPhase(
          "ack_snapshot_publish",
          performance.now() - snapshotStartedAt,
          { success: snapshotSucceeded }
        );
      }
    });
  };

  function drainCommandUpdates() {
    while (
      !commandUpdateQueueClosed &&
      activeCommandUpdatePublications < MAX_CONCURRENT_COMMAND_UPDATE_PUBLICATIONS &&
      commandUpdateQueue.length > 0
    ) {
      const state = commandUpdateQueue.shift()!;
      state.queued = false;
      state.inFlight = true;
      state.dirty = false;
      activeCommandUpdatePublications += 1;

      void publishCommandUpdate(state).catch((error) => {
        if (state.retryCount < 3) {
          state.retryCount += 1;
          state.dirty = true;
        }
        errorMonitor.trackError("websocket_error", error as Error, {
          operation: "classpilot_command_update",
        });
      }).finally(() => {
        state.inFlight = false;
        activeCommandUpdatePublications -= 1;
        if (commandUpdateQueueClosed) {
          commandUpdateStates.delete(state.key);
        } else if (state.dirty) {
          armCommandUpdate(state);
        } else {
          commandUpdateStates.delete(state.key);
        }
        drainCommandUpdates();
      });
    }
  }

  const scheduleCommandUpdate = (schoolId: string, commandId: string) => {
    const key = `${schoolId}:${commandId}`;
    const pending = commandUpdateStates.get(key);
    if (pending) {
      pending.dirty = true;
      return;
    }

    const state: CommandUpdateState = {
      key,
      schoolId,
      commandId,
      timer: null,
      queued: false,
      inFlight: false,
      dirty: false,
      retryCount: 0,
    };
    commandUpdateStates.set(key, state);
    armCommandUpdate(state);
  };
  registerClasspilotCommandUpdateScheduler(scheduleCommandUpdate);

  wss.once("close", () => {
    registerClasspilotCommandUpdateScheduler(null);
    commandUpdateQueueClosed = true;
    commandUpdateQueue.length = 0;
    for (const state of commandUpdateStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    commandUpdateStates.clear();
  });

  // --- Redis cross-instance message delivery ---
  const deliverRedisMessage = (target: WsRedisTarget, message: unknown) => {
    const msgType = (message as { type?: string })?.type ?? "unknown";
    const sessionId = (message as { sessionId?: unknown })?.sessionId;
    if (
      target.kind === "staff"
      && msgType === "session-ended"
      && typeof sessionId === "string"
      && sessionId.length > 0
      && sessionId.length <= 128
    ) {
      void stopActiveClasspilotLiveViewNegotiations({
        schoolId: target.schoolId,
        teachingSessionId: sessionId,
        reason: "session-ended",
      });
    }
    switch (target.kind) {
      case "staff":
        broadcastToTeachersLocal(target.schoolId, message);
        break;
      case "staff-user":
        sendToStaffUserLocal(target.schoolId, target.userId, message);
        break;
      case "staff-session":
        broadcastToStaffSessionLocal(target.schoolId, target.sessionId, message);
        break;
      case "students":
        broadcastToStudentsLocal(target.schoolId, message, undefined, target.targetDeviceIds);
        break;
      case "device":
        if (msgType === "teacher-message") {
          const legacyBinding = message && typeof message === "object"
            ? message as { studentId?: unknown; studentSessionId?: unknown }
            : null;
          if (
            !legacyBinding
            || typeof legacyBinding.studentId !== "string"
            || typeof legacyBinding.studentSessionId !== "string"
          ) {
            console.log("[Redis] Dropping teacher message without an exact student binding");
            break;
          }
          void deliverClasspilotStudentBindingRedisMessage({
            kind: "student-binding",
            schoolId: target.schoolId,
            studentId: legacyBinding.studentId,
            studentSessionId: legacyBinding.studentSessionId,
            deviceId: target.deviceId,
          }, message);
          break;
        }
        console.log(`[Redis] Delivering exact-bound ${msgType}`);
        sendToDeviceLocal(target.schoolId, target.deviceId, message);
        break;
      case "student-binding":
        console.log(`[Redis] Revalidating exact student-binding ${msgType}`);
        void deliverClasspilotStudentBindingRedisMessage(target, message);
        break;
      case "student-disconnect":
        closeStudentSocketsLocal(target.schoolId, target.studentIds);
        break;
      case "role":
        sendToRoleLocal(target.schoolId, target.role, message);
        break;
    }
  };

  void subscribeWS(deliverRedisMessage);

  // --- HTTP upgrade handling ---
  const wsAllowlist = (process.env.CORS_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  httpServer.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/";
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      console.warn("[WebSocket] Failed to parse upgrade URL");
    }

    // Socket.IO owns the GoPilot upgrade path. Do not let this raw ClassPilot
    // WebSocket handler destroy that socket, or clients fall back to long
    // polling and pollute ALB TargetResponseTime p95.
    if (isGoPilotSocketIoPath(pathname)) {
      return;
    }

    if (!isClassPilotWebSocketPath(pathname)) {
      console.warn("[WebSocket] Rejected upgrade for invalid path");
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Validate origin in production (allow Chrome extensions which send chrome-extension:// origin)
    const origin = request.headers.origin;
    const isExtensionOrigin = origin?.startsWith("chrome-extension://");
    if (wsAllowlist.length > 0 && origin && !isExtensionOrigin && !wsAllowlist.includes(origin)) {
      console.warn("[WebSocket] Rejected upgrade from unauthorized origin");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // --- Ping/pong keepalive helpers ---
  function startPingInterval(ws: WebSocket) {
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        stopPingInterval(ws);
        return;
      }

      // Check if previous pong was received
      if (clientPongPending.get(ws)) {
        console.log("[WebSocket] Client failed to respond to ping, closing connection");
        ws.terminate();
        return;
      }

      // Send ping and mark pong as pending
      clientPongPending.set(ws, true);
      ws.ping();

      const previousPongTimer = clientPongTimers.get(ws);
      if (previousPongTimer) clearTimeout(previousPongTimer);
      const pongTimer = setTimeout(() => {
        clientPongTimers.delete(ws);
        if (clientPongPending.get(ws) && ws.readyState === WebSocket.OPEN) {
          console.log("[WebSocket] Client exceeded pong timeout, closing connection");
          ws.terminate();
        }
      }, WS_PONG_TIMEOUT_MS);
      pongTimer.unref();
      clientPongTimers.set(ws, pongTimer);
    }, WS_PING_INTERVAL_MS);
    timer.unref();

    clientPingTimers.set(ws, timer);
  }

  function stopPingInterval(ws: WebSocket) {
    const timer = clientPingTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      clientPingTimers.delete(ws);
    }
    const pongTimer = clientPongTimers.get(ws);
    if (pongTimer) {
      clearTimeout(pongTimer);
      clientPongTimers.delete(ws);
    }
    clientPongPending.delete(ws);
  }

  // --- Connection handler ---
  wss.on("connection", (ws) => {
    const client = registerWsClient(ws);
    const frameBucket = createClasspilotWsFrameBucket();
    let pendingFrames = 0;
    let frameQueue: Promise<void> = Promise.resolve();
    let studentPongRevalidation: Promise<void> | null = null;
    let staffPongRevalidation: Promise<void> | null = null;
    const ownedLiveViewNegotiations = new Map<string, {
      schoolId: string;
      requesterUserId: string;
    }>();
    const forgetOwnedLiveView = (negotiationId: string): void => {
      ownedLiveViewNegotiations.delete(negotiationId);
    };
    const stopOwnedLiveViews = (reason: string): void => {
      const owned = [...ownedLiveViewNegotiations.entries()];
      ownedLiveViewNegotiations.clear();
      for (const [negotiationId, authority] of owned) {
        void stopActiveClasspilotLiveViewNegotiations({
          schoolId: authority.schoolId,
          requesterUserId: authority.requesterUserId,
          negotiationIds: [negotiationId],
          reason,
        });
      }
    };
    const presenceConnectionId = randomUUID();
    let recordedPresence: { schoolId: string; userId: string } | null = null;
    let presenceMutation = Promise.resolve();
    const queuePresenceMutation = (mutation: () => Promise<unknown>): Promise<void> => {
      presenceMutation = presenceMutation
        .then(mutation, mutation)
        .then(() => undefined)
        .catch(() => {
          // Presence is advisory but safety-sensitive. Redis-backed methods
          // already return false on infrastructure errors; injected stores may
          // throw, so keep the socket healthy and let the scheduler fail closed.
          console.warn("[WebSocket] ClassPilot staff presence update failed");
        });
      return presenceMutation;
    };
    const recordStaffPresence = async (schoolId: string, userId: string): Promise<void> => {
      const previous = recordedPresence;
      recordedPresence = { schoolId, userId };
      await queuePresenceMutation(async () => {
        if (previous && (previous.schoolId !== schoolId || previous.userId !== userId)) {
          await removeClasspilotStaffPresence(
            presenceStore,
            previous.schoolId,
            previous.userId,
            presenceConnectionId
          );
        }
        await touchClasspilotStaffPresence(presenceStore, schoolId, userId, presenceConnectionId);
      });
    };
    const refreshStaffPresence = (): void => {
      const current = recordedPresence;
      if (!current) return;
      void queuePresenceMutation(() =>
        touchClasspilotStaffPresence(
          presenceStore,
          current.schoolId,
          current.userId,
          presenceConnectionId
        )
      );
    };
    const clearStaffPresence = (): void => {
      const current = recordedPresence;
      if (!current) return;
      recordedPresence = null;
      void queuePresenceMutation(() =>
        removeClasspilotStaffPresence(
          presenceStore,
          current.schoolId,
          current.userId,
          presenceConnectionId
        )
      );
    };
    const validatePassiveAuthorization = async (): Promise<boolean> => {
      if (!client.authenticated || !client.schoolId) return false;
      if (
        mayUsePassiveWebSocketAuthorizationCache(client.role)
        && hasFreshPassiveWebSocketAuthorization(client)
      ) {
        activity.passiveAuthorizationCacheHits += 1;
        return true;
      }

      const binding = client.role === "student"
        ? {
            role: client.role,
            schoolId: client.schoolId,
            studentId: client.studentId,
            studentSessionId: client.studentSessionId,
            deviceId: client.deviceId,
            userId: undefined,
            authVersion: undefined,
          }
        : {
            role: client.role,
            schoolId: client.schoolId,
            studentId: undefined,
            studentSessionId: undefined,
            deviceId: undefined,
            userId: client.userId,
            authVersion: client.authVersion,
          };
      const generation = passiveAuthorizationGeneration(binding.schoolId);
      const key = binding.role === "student"
        ? `student:${binding.schoolId}:${binding.studentId ?? ""}:${binding.studentSessionId ?? ""}:${binding.deviceId ?? ""}`
        : `staff:${binding.schoolId}:${binding.userId ?? ""}:${binding.role}:${binding.authVersion ?? 1}`;
      const outcome = await singleFlightPassiveAuthorization(key, async () => {
        if (binding.role === "student") {
          return resolveActiveStudentWebSocketAuthorization(binding);
        }
        const [role, user] = await Promise.all([
          activeStaffWebSocketRole(binding),
          binding.userId ? getUserById(binding.userId) : Promise.resolve(undefined),
        ]);
        return {
          authorized: role === binding.role && Boolean(
            user && credentialVersionMatches(binding.authVersion, user.authVersion)
          ),
          authorityExpiresAtMs: null,
        };
      });
      if (outcome.joined) activity.passiveAuthorizationJoins += 1;
      else if (outcome.bypassed) activity.passiveAuthorizationBypasses += 1;
      else activity.passiveAuthorizationLoads += 1;

      const bindingUnchanged =
        client.authenticated &&
        client.role === binding.role &&
        client.schoolId === binding.schoolId &&
        client.studentId === binding.studentId &&
        client.studentSessionId === binding.studentSessionId &&
        client.deviceId === binding.deviceId &&
        client.userId === binding.userId &&
        client.authVersion === binding.authVersion;
      if (!outcome.decision.authorized || !bindingUnchanged) {
        activity.passiveAuthorizationDenied += 1;
        return false;
      }
      // An invalidation racing the query prevents caching its result. The
      // passive frame is harmless, and the next ping immediately reloads.
      if (
        mayUsePassiveWebSocketAuthorizationCache(binding.role)
        && passiveAuthorizationGeneration(binding.schoolId) === generation
      ) {
        rememberPassiveWebSocketAuthorization(
          client,
          outcome.decision.authorityExpiresAtMs
        );
      }
      return true;
    };
    activity.connected += 1;

    // Start ping/pong keepalive
    startPingInterval(ws);

    // Handle pong responses
    ws.on("pong", () => {
      clientPongPending.set(ws, false);
      const pongTimer = clientPongTimers.get(ws);
      if (pongTimer) {
        clearTimeout(pongTimer);
        clientPongTimers.delete(ws);
      }
      refreshStaffPresence();
      if (!client.authenticated) return;
      if (client.role === "student") {
        if (studentPongRevalidation || !client.schoolId || !client.studentId) return;
        const pending = validatePassiveAuthorization()
          .then((active) => {
            if (!active && client.schoolId && client.studentId) {
              closeStudentSocketsLocal(client.schoolId, [client.studentId]);
            }
          })
          .catch((error) => {
            const safeError = studentAuthenticationServiceError(error);
            errorMonitor.trackError("database_connectivity", safeError, {
              job: "studentWebSocketPongRevalidation",
              errorCode: (safeError as NodeJS.ErrnoException).code,
            }, { persist: false, priority: "high" });
            client.authenticated = false;
            removeWsClient(ws);
            if (ws.readyState === WebSocket.OPEN) ws.close(1013, "Authentication service unavailable");
          });
        studentPongRevalidation = pending;
        void pending.finally(() => {
          if (studentPongRevalidation === pending) studentPongRevalidation = null;
        });
        return;
      }
      if (staffPongRevalidation) return;
      const pending = validatePassiveAuthorization()
        .then((authorized) => {
          if (!authorized) {
            client.authenticated = false;
            clearStaffPresence();
            removeWsClient(ws);
            if (ws.readyState === WebSocket.OPEN) ws.close(1008, "Staff access changed");
          }
        })
        .catch((error) => {
          errorMonitor.trackError("database_connectivity", error as Error, {
            job: "staffWebSocketPongRevalidation",
          }, { persist: false, priority: "high" });
          client.authenticated = false;
          clearStaffPresence();
          removeWsClient(ws);
          if (ws.readyState === WebSocket.OPEN) ws.close(1013, "Authentication service unavailable");
        });
      staffPongRevalidation = pending;
      void pending.finally(() => {
        if (staffPongRevalidation === pending) staffPongRevalidation = null;
      });
    });

    const handleMessage = async (data: RawData): Promise<void> => {
      let messageType = "unknown";
      try {
        const message = JSON.parse(data.toString());
        messageType = typeof message?.type === "string" ? message.type : "unknown";

        // Log non-auth, non-heartbeat messages for debugging
        if (message.type !== "auth" && message.type !== "heartbeat") {
          console.log(
            `[WebSocket] Message received: ${message.type} from ${client.role || "unauthenticated"} (authenticated: ${client.authenticated})`
          );
        }

        // --- Auth handling ---
        if (message.type === "auth") {
          // Student auth requires an already issued, active student session token.
          // Email-only WebSocket provisioning is intentionally disabled because
          // it cannot prove the request came from the managed extension deployment.
          if (message.role === "student" && message.deviceId) {
            if (message.studentToken) {
              let payload: ReturnType<typeof verifyStudentToken>;
              try {
                payload = verifyStudentToken(message.studentToken);
              } catch (error) {
                const msg = error instanceof TokenExpiredError
                  ? "Token expired, please re-register"
                  : error instanceof InvalidTokenError
                    ? "Invalid token"
                    : "Authentication failed";
                ws.send(JSON.stringify({ type: "auth-error", message: msg }));
                ws.close();
                return;
              }

              let studentBootstrapAuthenticated = false;
              try {
                const schoolId = payload.schoolId;
                const deviceId = payload.deviceId;
                const bootstrapAuthorized = await runWithTenantContext({ schoolId }, async () => {
                  const activeSession = await resolveActiveStudentTokenSession(payload);
                  if (!activeSession) return false;
                  if (!(await resolveClasspilotEntitlement(schoolId)).entitled) return false;
                  const schoolSettings = await getSettingsForSchool(schoolId);
                  const protocol = negotiateClasspilotSurfaceProtocol({
                    surface: "websocket_auth",
                    payload: message,
                    scope: {
                      serverOrigin: process.env.PUBLIC_BASE_URL,
                      schoolId,
                      deviceId,
                      studentId: payload.studentId,
                      studentSessionId: activeSession.id,
                    },
                  });

                  // Resolve the optional Redis-backed observation hint before
                  // entering the exact student-control transaction. The
                  // resolver below accepts this result only if the locked
                  // authority still names the same teaching session, so a
                  // concurrent class change can only degrade to background
                  // cadence and cannot widen screenshot authority.
                  const cadenceState = protocol.acceptedCapabilities.includes(
                    "screenshotActiveObservationCadenceV1"
                  )
                    ? await getClasspilotStudentControlState(schoolId, payload.studentId)
                    : null;
                  const cadenceTeachingSessionId = cadenceState?.supervisionContextId
                    ? null
                    : cadenceState?.teachingSessionId ?? null;
                  const cadenceObservationCheckedAt = Date.now();
                  const cadenceObservation: ClasspilotObservationStatus = cadenceTeachingSessionId
                    ? await classpilotObservationStatus({
                        schoolId,
                        teachingSessionId: cadenceTeachingSessionId,
                        studentId: payload.studentId,
                      })
                    : { status: "unavailable", expiresInSeconds: 0 };

                  const authority = await withClasspilotStudentWebSocketBootstrapAuthority(
                    {
                      schoolId,
                      studentId: payload.studentId,
                      studentSessionId: activeSession.id,
                      deviceId,
                    },
                    async (transactionDb) => {
                      await lockClasspilotSsoPolicyDeliveryAuthority(schoolId, transactionDb);
                      // Read state only after taking the same student-control
                      // lock used by command persistence and session transfer.
                      // A push committed before this socket was registered can
                      // therefore never be overwritten by an older bootstrap.
                      const fab = await buildStudentFabState(schoolId, payload.studentId, {
                        schoolSettings,
                        studentSessionId: activeSession.id,
                        dbInstance: transactionDb,
                      });
                      const [classroomStateRow, ssoPolicy] = await Promise.all([
                        getClasspilotStudentControlState(
                          schoolId,
                          payload.studentId,
                          transactionDb
                        ),
                        getClasspilotSsoPolicyForSchool(schoolId, transactionDb),
                      ]);
                      const screenshotTrackingAuthority = await getClasspilotScreenshotAuthorityProjection({
                        schoolId,
                        studentId: payload.studentId,
                        studentSessionId: activeSession.id,
                        deviceId,
                      }, transactionDb);
                      const authDelivery = classroomStateRow
                        ? serializeClasspilotStudentControlStateForDelivery({
                            state: classroomStateRow,
                            gateActive: isClasspilotCapabilityActive(
                              "lateSignInRestrictionSsoV1",
                              { schoolId }
                            ),
                            acceptedCapabilities: protocol.acceptedCapabilities,
                            exactBinding: {
                              schoolId,
                              deviceId,
                              studentId: payload.studentId,
                              studentSessionId: activeSession.id,
                            },
                            authPassThrough: {
                              gateActive: isClasspilotCapabilityActive(
                                "restrictionAuthPassThroughV1",
                                { schoolId }
                              ),
                              policyRevision: ssoPolicy.revision,
                              policy: ssoPolicy.policy,
                            },
                          })
                        : { classroomState: null, withheld: false };
                      const classroomState = authDelivery.classroomState;
                      const screenshotPolicy = await resolveClasspilotScreenshotPolicy({
                        schoolId,
                        studentId: payload.studentId,
                        teachingSessionId: classroomStateRow?.teachingSessionId ?? null,
                        acceptedCapabilities: protocol.acceptedCapabilities,
                        trackingSettings: schoolSettings,
                        trackingAuthority: classpilotScreenshotAuthorityForDeliveredControl({
                          projection: screenshotTrackingAuthority,
                          deliveredControlRevision: classroomState?.revision ?? 0,
                        }),
                        observationStatus: async ({ teachingSessionId, now }) => {
                          if (teachingSessionId !== cadenceTeachingSessionId) {
                            return { status: "unavailable", expiresInSeconds: 0 };
                          }
                          if (cadenceObservation.status !== "observed") return cadenceObservation;
                          return {
                            status: "observed",
                            expiresInSeconds: Math.max(
                              0,
                              cadenceObservation.expiresInSeconds - Math.ceil(
                                (Math.max(cadenceObservationCheckedAt, now ?? Date.now())
                                  - cadenceObservationCheckedAt) / 1000
                              )
                            ),
                          };
                        },
                      });
                      return {
                        fab,
                        classroomState,
                        screenshotPolicy,
                        deliveryWithheld: authDelivery.withheld,
                      };
                    },
                    (teacherReplies, prepared) => {
                      if (ws.readyState !== WebSocket.OPEN) {
                        throw new Error("Student WebSocket closed during authentication");
                      }
                      if (prepared.deliveryWithheld) {
                        recordHeartbeatHotPathCounter("lateSignInDeliveryWithheld");
                      } else if (prepared.classroomState?.deliveryContext?.lateSignInRestrictionSso) {
                        recordHeartbeatHotPathCounter("lateSignInCapableDelivery");
                      }
                      clearStaffPresence();
                      const authenticated = authenticateWsClient(ws, {
                        role: "student",
                        deviceId,
                        schoolId,
                        studentId: payload.studentId,
                        studentSessionId: activeSession.id,
                        acceptedCapabilities: protocol.acceptedCapabilities,
                      });
                      if (!authenticated) {
                        throw new Error("Student WebSocket registration is unavailable");
                      }
                      studentBootstrapAuthenticated = true;

                      // These frames are synchronously queued while the exact
                      // binding's transaction lock is held. Session transfer
                      // cannot commit between final authority validation and
                      // delivery of the authoritative bootstrap state.
                      ws.send(JSON.stringify({
                        type: "auth-success",
                        role: "student",
                        schoolId,
                        studentId: payload.studentId,
                        studentSessionId: activeSession.id,
                        ...protocol,
                        screenshotPolicy: prepared.screenshotPolicy,
                        exactBinding: classpilotControlStateExactBinding({
                          schoolId,
                          deviceId,
                          studentId: payload.studentId,
                          studentSessionId: activeSession.id,
                          controlRevision: prepared.classroomState?.revision ?? 0,
                        }),
                        settings: {
                          maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
                            ? parseInt(schoolSettings.maxTabsPerStudent, 10) : null,
                          globalBlockedDomains: schoolSettings?.blockedDomains || [],
                          fab: {
                            ...prepared.fab,
                            ownershipRevision: prepared.classroomState?.revision ?? 0,
                          },
                        },
                        // Explicit null is authoritative on shared Chromebooks.
                        // If the new student has no desired row, omitting the
                        // field would preserve the former student's controls.
                        classroomState: prepared.classroomState,
                      }));
                      for (const { message: teacherMessage } of teacherReplies) {
                        ws.send(JSON.stringify({
                          type: "teacher-message",
                          _msgId: teacherMessage.id,
                          chatMessageId: teacherMessage.id,
                          messageId: teacherMessage.id,
                          sessionId: teacherMessage.sessionId,
                          studentId: payload.studentId,
                          studentSessionId: activeSession.id,
                          message: teacherMessage.content,
                          fromName: "Teacher",
                        }));
                      }
                    }
                  );
                  return authority.authorized;
                });
                if (!bootstrapAuthorized) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Student session is no longer active" }));
                  ws.close();
                  return;
                }
                activity.studentAuthenticated += 1;
              } catch (error) {
                if (studentBootstrapAuthenticated) {
                  removeWsClient(ws);
                }
                const safeError = studentAuthenticationServiceError(error);
                console.error("[WebSocket] Student authentication service unavailable", {
                  errorCode: (safeError as NodeJS.ErrnoException).code ?? "unknown",
                });
                errorMonitor.trackError("database_connectivity", safeError, {
                  job: "studentWebSocketAuth",
                  messageType: "authentication_service_error",
                  errorCode: (safeError as NodeJS.ErrnoException).code,
                }, { persist: false, priority: "high" });
                ws.send(JSON.stringify({ type: "auth-error", message: "Authentication service unavailable" }));
                ws.close(1013, "Authentication service unavailable");
                return;
              }
            } else {
              ws.send(JSON.stringify({ type: "auth-error", message: "Student token required" }));
              ws.close();
              return;
            }
          }

          // Staff auth via userToken (JWT-based, no session dependency)
          if (
            message.role === "teacher" ||
            message.role === "office_staff" ||
            message.role === "school_admin" ||
            message.role === "super_admin"
          ) {
            if (!message.userToken) {
              ws.send(JSON.stringify({ type: "auth-error", message: "User token required" }));
              ws.close();
              return;
            }

            try {
              const payload = verifyUserToken(message.userToken);
              const userId = payload.userId;
              const schoolId = message.schoolId;

              const user = await getUserById(userId);
              if (!user || !credentialVersionMatches(payload.authVersion, user.authVersion)) {
                ws.send(JSON.stringify({
                  type: "auth-error",
                  message: "Credentials have changed. Sign in again.",
                  code: "CREDENTIAL_INVALIDATED",
                }));
                ws.close(1008, "Credentials invalidated");
                return;
              }

              if (!schoolId) {
                ws.send(JSON.stringify({ type: "auth-error", message: "School context required" }));
                ws.close();
                return;
              }

              // Verify current product entitlement and role from server state
              // instead of trusting the client-provided role. Super-admin may
              // select a school without membership, but never bypasses a
              // disabled or unlicensed ClassPilot school.
              const role = await activeStaffWebSocketRole({
                role: payload.isSuperAdmin ? "super_admin" : message.role,
                userId,
                schoolId,
              });
              if (!role) {
                ws.send(JSON.stringify({
                  type: "auth-error",
                  message: "No active ClassPilot access for this school",
                }));
                ws.close(1008, "ClassPilot access unavailable");
                return;
              }

              const authenticatedClient = authenticateWsClient(ws, {
                role,
                userId,
                schoolId,
                authVersion: payload.authVersion ?? 1,
              });

              if (!authenticatedClient) {
                ws.send(JSON.stringify({ type: "auth-error", message: "Authentication failed" }));
                ws.close(1011, "Authentication state unavailable");
                return;
              }

              // Close the race between the first credential read and making
              // this socket visible to credential invalidation. If a version
              // bump committed before registration, this read observes it; if
              // it commits later, the registered socket is closed by the
              // local/Redis invalidation path.
              const currentUser = await getUserById(userId);
              if (
                !currentUser ||
                !credentialVersionMatches(authenticatedClient.authVersion, currentUser.authVersion)
              ) {
                removeWsClient(ws);
                ws.send(JSON.stringify({
                  type: "auth-error",
                  message: "Credentials have changed. Sign in again.",
                  code: "CREDENTIAL_INVALIDATED",
                }));
                ws.close(1008, "Credentials invalidated");
                return;
              }

              // Authentication is never gated on Redis. The presence write is
              // strictly bounded and the post-write pickup closes the bell-time
              // race where a scheduler worker may have created a conflict just
              // before this API task made the socket visible across processes.
              const presenceRecorded = recordStaffPresence(schoolId, userId);
              ws.send(JSON.stringify({ type: "auth-success", role }));
              activity.staffAuthenticated += 1;
              if (role === "office_staff") return;
              void presenceRecorded.then(() =>
                runWithTenantContext({ schoolId }, async () => {
                  await assertClasspilotEntitled(schoolId);
                  const started = await startActiveScheduledClassesForTeacher({ schoolId, teacherId: userId });
                  if (started.length > 0) {
                    broadcastScheduledClassUpdate(schoolId, {
                      type: "scheduled-class-conflict-updated",
                      startedSessionIds: started.map((session) => session.id),
                    });
                  }
                })
              ).catch((error) => {
                console.error(
                  "[WebSocket] Scheduled class pickup on staff login failed:",
                  safeErrorMetadata(error)
                );
                errorMonitor.trackError("scheduler_failure", error as Error, {
                  job: "scheduledClassLoginPickup",
                  schoolId,
                  teacherId: userId,
                });
              });
            } catch (error) {
              console.error("[WebSocket] Staff auth error:", safeErrorMetadata(error));
              ws.send(JSON.stringify({ type: "auth-error", message: "Authentication failed" }));
              ws.close();
              return;
            }
          }
        }

        // Every post-authentication message requires a current persisted role;
        // a cached teacher role must not survive demotion or deactivation.
        if (!client.authenticated) return;
        const passiveMessage = message.type === "heartbeat" || message.type === "ping";
        if (
          client.role !== "student" &&
          message.type !== "auth"
        ) {
          try {
            const authorized = passiveMessage
              ? await validatePassiveAuthorization()
              : await Promise.all([
                  activeStaffWebSocketRole(client),
                  client.userId ? getUserById(client.userId) : Promise.resolve(undefined),
                ]).then(([role, user]) =>
                  role === client.role && Boolean(
                    user && credentialVersionMatches(client.authVersion, user.authVersion)
                  )
                );
            if (!authorized) {
              client.authenticated = false;
              clearStaffPresence();
              removeWsClient(ws);
              ws.send(JSON.stringify({ type: "auth-error", message: "Staff access changed" }));
              ws.close(1008, "Staff access changed");
              return;
            }
          } catch (error) {
            errorMonitor.trackError("database_connectivity", error as Error, {
              job: "staffWebSocketMessageRevalidation",
              messageType,
            }, { persist: false, priority: "high" });
            client.authenticated = false;
            clearStaffPresence();
            removeWsClient(ws);
            ws.send(JSON.stringify({ type: "auth-error", message: "Authentication service unavailable" }));
            ws.close(1013, "Authentication service unavailable");
            return;
          }
        }

        // Authentication is not a one-time authorization grant. Deactivating a
        // student ends the backing device session, so every subsequent
        // student-originating message must prove that exact binding is still
        // active before any chat/classroom/ack/WebRTC mutation can run.
        if (client.role === "student" && message.type !== "auth") {
          try {
            const authorized = passiveMessage
              ? await validatePassiveAuthorization()
              : await hasActiveStudentWebSocketBinding(client);
            if (!authorized) {
              ws.send(JSON.stringify({
                type: "auth-error",
                message: "Student session is no longer active",
              }));
              ws.close(1008, "Student session is no longer active");
              return;
            }
          } catch (error) {
            const safeError = studentAuthenticationServiceError(error);
            errorMonitor.trackError("database_connectivity", safeError, {
              job: "studentWebSocketRevalidation",
              messageType,
              errorCode: (safeError as NodeJS.ErrnoException).code,
            }, { persist: false, priority: "high" });
            ws.send(JSON.stringify({
              type: "auth-error",
              message: "Authentication service unavailable",
            }));
            ws.close(1013, "Authentication service unavailable");
            return;
          }
        }

        // --- Passive heartbeat handling ---
        // Only this non-mutating path may use the bounded 30-second cache.
        // Every command, ACK, chat, subscription, and signaling frame above
        // still performed a fresh authoritative check.
        if (passiveMessage) {
          refreshStaffPresence();
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // --- Staff session subscriptions for session-scoped FAB events ---
        if (
          (message.type === "subscribe-session" || message.type === "unsubscribe-session") &&
          client.schoolId &&
          (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")
        ) {
          const parsed = parseClasspilotSessionSubscription(message);
          if (!parsed.ok) {
            ws.send(JSON.stringify({
              type: "session-subscription-error",
              code: parsed.code,
              error: parsed.code === "REQUEST_ID_INVALID"
                ? "Invalid request ID"
                : "Teaching session required",
              ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
            }));
            return;
          }
          const sessionId = parsed.teachingSessionId;
          const subscriptionMutation = beginClasspilotSessionSubscriptionMutation(client, sessionId);
          const subscriptionMutationIsCurrent = () => {
            const currentClient = getWsClient(ws);
            return currentClient === client
              && isCurrentClasspilotSessionSubscriptionMutation(currentClient, subscriptionMutation);
          };

          // Unsubscription only narrows this socket's access. It must remain
          // available after a session ends or the staff member is reassigned;
          // otherwise a socket that previously subscribed can be stranded on
          // the old session fan-out after it has lost authority.
          if (parsed.action === "unsubscribe") {
            if (!unsubscribeWsClientFromSession(ws, sessionId)) {
              ws.send(JSON.stringify({
                type: "session-subscription-error",
                teachingSessionId: sessionId,
                sessionId,
                code: "SUBSCRIPTION_SERVICE_UNAVAILABLE",
                error: "Session subscription service unavailable",
                ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
              }));
              return;
            }
            ws.send(JSON.stringify({
              type: "session-unsubscription-success",
              teachingSessionId: sessionId,
              sessionId,
              ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
            }));
            return;
          }

          let allowed: boolean;
          try {
            allowed = await runWithTenantContext({ schoolId: client.schoolId }, async () => {
              const session = await getTeachingSessionByIdAndSchool(sessionId, client.schoolId!);
              if (
                !session
                || session.endTime
                || session.sessionMode !== "live"
                || !session.rosterSnapshotCompletedAt
              ) return false;
              if (client.role === "school_admin" || client.role === "super_admin") return true;
              return isAuthorizedClasspilotSessionStaff(
                client.schoolId!,
                sessionId,
                client.userId!
              );
            });
          } catch (error) {
            if (!subscriptionMutationIsCurrent()) return;
            errorMonitor.trackError("database_connectivity", error as Error, {
              job: "classpilotSessionSubscription",
              messageType,
            }, { persist: false, priority: "high" });
            ws.send(JSON.stringify({
              type: "session-subscription-error",
              teachingSessionId: sessionId,
              sessionId,
              code: "SUBSCRIPTION_SERVICE_UNAVAILABLE",
              error: "Session subscription service unavailable",
              ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
            }));
            return;
          }

          // A later subscribe/unsubscribe for this session wins even if this
          // authorization check resolves out of order.
          if (!subscriptionMutationIsCurrent()) return;

          if (!allowed) {
            ws.send(JSON.stringify({
              type: "session-subscription-error",
              teachingSessionId: sessionId,
              sessionId,
              code: "SESSION_UNAVAILABLE",
              error: "Teaching session unavailable",
              ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
            }));
            return;
          }

          if (!subscribeWsClientToSession(ws, sessionId)) {
            ws.send(JSON.stringify({
              type: "session-subscription-error",
              teachingSessionId: sessionId,
              sessionId,
              code: "SUBSCRIPTION_SERVICE_UNAVAILABLE",
              error: "Session subscription service unavailable",
              ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
            }));
            return;
          }
          ws.send(JSON.stringify({
            type: "session-subscription-success",
            teachingSessionId: sessionId,
            sessionId,
            ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
          }));
          return;
        }

        // --- Student FAB chat delivery acknowledgements ---
        if (
          client.role === "student" &&
          client.schoolId &&
          client.studentId &&
          client.studentSessionId &&
          client.deviceId &&
          (message.type === "chat-message-ack" || message.type === "chat_delivery_ack")
        ) {
          const messageId = String(message.messageId || message.chatMessageId || "").trim();
          const rawStatus = String(message.deliveryStatus || message.status || "").trim();
          const deliveryStatus = rawStatus === "failed" ? "failed" : rawStatus === "delivered" ? "delivered" : null;
          if (!messageId || !deliveryStatus) return;

          const acknowledged = await runWithTenantContext({ schoolId: client.schoolId }, () =>
            acknowledgeTeacherChatDelivery({
              chatMessageId: messageId,
              schoolId: client.schoolId!,
              studentId: client.studentId!,
              studentSessionId: client.studentSessionId!,
              deviceId: client.deviceId!,
              status: deliveryStatus,
              errorMessage: message.error || message.errorMessage || null,
            })
          );

          if (acknowledged?.message.sessionId) {
            const payload = {
              type: "chat-message-delivery",
              sessionId: acknowledged.message.sessionId,
              messageId,
              studentId: acknowledged.message.studentId,
              deliveryStatus: acknowledged.message.deliveryStatus,
              errorMessage: acknowledged.message.errorMessage,
            };
            broadcastToStaffSessionLocal(client.schoolId, acknowledged.message.sessionId, payload);
            void publishWS({ kind: "staff-session", schoolId: client.schoolId, sessionId: acknowledged.message.sessionId }, payload);
          }
          if (message.ackId) {
            ws.send(JSON.stringify({
              type: "chat-message-ack-receipt",
              ackId: String(message.ackId),
              messageId,
              accepted: !!acknowledged,
            }));
          }
          return;
        }

        // --- ClassPilot teacher command acknowledgements ---
        if (
          client.role === "student"
          && client.schoolId
          && client.studentId
          && client.studentSessionId
          && client.deviceId
          && message.type === "classroom-state-ack"
        ) {
          const appliedRevision = Number(message.appliedRevision);
          const appliedAuthPolicyRevision = (
            typeof message.appliedAuthPolicyRevision === "number"
            && Number.isSafeInteger(message.appliedAuthPolicyRevision)
            && message.appliedAuthPolicyRevision >= 0
          ) ? message.appliedAuthPolicyRevision : null;
          const rawOutcome = String(message.outcome || "").toLowerCase();
          const outcome = rawOutcome === "applied"
            ? "applied"
            : rawOutcome === "failed"
              ? "failed"
              : rawOutcome === "expired"
                ? "expired"
                : rawOutcome === "unsupported"
                  ? "unsupported"
                  : null;
          if (Number.isSafeInteger(appliedRevision) && appliedRevision >= 0 && outcome) {
            const acknowledgedState = await runWithTenantContext({ schoolId: client.schoolId }, async () => {
              const schoolId = client.schoolId!;
              const studentId = client.studentId!;
              const studentSessionId = client.studentSessionId!;
              const deviceId = client.deviceId!;
              // Unchanged classroom-state re-pushes make the extension re-ACK
              // the revision it already applied. Gate exactly like the
              // heartbeat ACK so an unchanged ACK performs no write; the
              // storage ACK still revalidates everything under its own locks.
              const controlState = await getClasspilotStudentControlState(schoolId, studentId);
              if (controlState) {
                const deferredBindingAlreadyApplied = classpilotLateSignInRevisionAppliedToBinding({
                  desiredState: controlState.desiredState,
                  binding: { schoolId, studentId, studentSessionId, deviceId },
                  revision: appliedRevision,
                });
                const restrictionAuthRevisionMismatch = (
                  classpilotControlStateHasAuthRelevantRestriction(controlState.desiredState)
                  && client.acceptedCapabilities?.includes("restrictionAuthPassThroughV1") === true
                  && appliedAuthPolicyRevision !== classpilotRestrictionAuthProjectionRevision({
                    policyRevision: (await getClasspilotSsoPolicyForSchool(schoolId)).revision,
                    gateActive: isClasspilotCapabilityActive(
                      "restrictionAuthPassThroughV1",
                      { schoolId }
                    ),
                  })
                );
                const ackRequired = classpilotControlStateAckRequired({
                  controlState,
                  appliedRevision,
                  outcome,
                  lateSignInOriginPending: !deferredBindingAlreadyApplied
                    && classpilotControlStateHasLateSignInOrigin(controlState.desiredState),
                  restrictionAuthRevisionMismatch,
                });
                if (!ackRequired) return undefined;
              }
              return acknowledgeClasspilotStudentControlState({
                schoolId,
                studentId,
                studentSessionId,
                deviceId,
                appliedRevision,
                appliedAuthPolicyRevision,
                outcome,
                error: message.error ? String(message.error) : null,
                acceptedCapabilities: client.acceptedCapabilities,
              });
            });
            if (acknowledgedState?.sourceCommandId) {
              scheduleCommandUpdate(client.schoolId, acknowledgedState.sourceCommandId);
            }
            if (
              acknowledgedState
              && classpilotControlStateHasLateSignInOrigin(acknowledgedState.desiredState)
            ) {
              recordHeartbeatHotPathCounter("lateSignInDeferredAck");
            }
          }
          return;
        }

        if (
          client.role === "student"
          && client.schoolId
          && client.studentId
          && client.studentSessionId
          && client.deviceId
          && message.type === "classroom-state-request"
        ) {
          const reconciliation = await runWithTenantContext(
            { schoolId: client.schoolId },
            () => withClasspilotStudentControlDeliveryAuthority(
              {
                schoolId: client.schoolId!,
                studentId: client.studentId!,
                studentSessionId: client.studentSessionId!,
                deviceId: client.deviceId!,
              },
              async (transactionDb) => {
                await lockClasspilotSsoPolicyDeliveryAuthority(
                  client.schoolId!,
                  transactionDb
                );
                const [state, ssoPolicy] = await Promise.all([
                  getClasspilotStudentControlState(
                    client.schoolId!,
                    client.studentId!,
                    transactionDb
                  ),
                  getClasspilotSsoPolicyForSchool(client.schoolId!, transactionDb),
                ]);
                const delivery = state
                  ? serializeClasspilotStudentControlStateForDelivery({
                      state,
                      gateActive: isClasspilotCapabilityActive(
                        "lateSignInRestrictionSsoV1",
                        { schoolId: client.schoolId! }
                      ),
                      acceptedCapabilities: client.acceptedCapabilities ?? [],
                      exactBinding: {
                        schoolId: client.schoolId!,
                        studentId: client.studentId!,
                        studentSessionId: client.studentSessionId!,
                        deviceId: client.deviceId!,
                      },
                      authPassThrough: {
                        gateActive: isClasspilotCapabilityActive(
                          "restrictionAuthPassThroughV1",
                          { schoolId: client.schoolId! }
                        ),
                        policyRevision: ssoPolicy.revision,
                        policy: ssoPolicy.policy,
                      },
                    })
                  : { classroomState: null, withheld: false };
                return delivery;
              },
              (_claimed, delivery) => {
                if (ws.readyState !== WebSocket.OPEN) {
                  throw new Error("Student WebSocket closed during classroom-state recovery");
                }
                if (delivery.withheld) return;
                const delivered = delivery.classroomState;
                // Queue the authoritative frame synchronously while the same
                // student-control lock used by correct-PIN transfer remains
                // held. Transfer cannot retire this binding after the final
                // database-clock check but before this send.
                ws.send(JSON.stringify(classpilotClassroomStatePushFrame({
                  type: "classroom-state-sync",
                  binding: {
                    schoolId: client.schoolId!,
                    deviceId: client.deviceId!,
                    studentId: client.studentId!,
                    studentSessionId: client.studentSessionId!,
                    controlRevision: delivered?.revision ?? 0,
                  },
                  classroomState: delivered,
                })));
              }
            )
          );
          if (!reconciliation.authorized) {
            ws.send(JSON.stringify({ type: "auth-error", message: "Student session is no longer active" }));
            ws.close();
            return;
          }
          return;
        }

        if (
          client.role === "student" &&
          client.schoolId &&
          client.studentId &&
          client.studentSessionId &&
          client.deviceId &&
          (message.type === "command-ack" ||
            message.type === "command_ack" ||
            message.type === "classpilot-command-ack" ||
            message.type === "remote-control-result")
        ) {
          const commandId = String(
            message.commandId ||
              message.command?.commandId ||
              message.data?.commandId ||
              ""
          ).trim();
          const ackId = typeof message.ackId === "string"
            ? message.ackId.trim().slice(0, 128)
            : "";
          if (!classpilotAckEnvelopeMatchesBinding(message, {
            schoolId: client.schoolId,
            studentId: client.studentId,
            studentSessionId: client.studentSessionId,
            deviceId: client.deviceId,
          })) {
            if (ackId) {
              ws.send(JSON.stringify({
                type: "command-ack-receipt",
                ...terminalClasspilotCommandAckReceipt(
                  ackId,
                  commandId,
                  "COMMAND_ACK_BINDING_MISMATCH"
                ),
              }));
            }
            return;
          }
          const rawAckState = String(
            message.ackState ||
              message.status ||
              message.resultStatus ||
              ""
          ).trim();
          const ackState = rawAckState === "failed"
            ? "failed"
            : rawAckState === "expired"
              ? "expired"
              : rawAckState === "completed" || rawAckState === "success"
                ? "completed"
                : rawAckState === "received"
                  ? "received"
                  : null;

          if (!commandId || !ackState) {
            if (ackId) {
              ws.send(JSON.stringify({
                type: "command-ack-receipt",
                ...terminalClasspilotCommandAckReceipt(
                  ackId,
                  commandId,
                  "COMMAND_ACK_MALFORMED"
                ),
              }));
            }
            return;
          }
          const rawResult = message.result || message.state || message.data || null;
          const serializedResult = rawResult === null ? null : JSON.stringify(rawResult);
          if (serializedResult && Buffer.byteLength(serializedResult, "utf8") > 16 * 1024) {
            if (ackId) {
              ws.send(JSON.stringify({
                type: "command-ack-receipt",
                ...terminalClasspilotCommandAckReceipt(
                  ackId,
                  commandId,
                  "COMMAND_ACK_MALFORMED"
                ),
              }));
            }
            return;
          }
          const boundedError = message.error || message.errorMessage
            ? String(message.error || message.errorMessage).slice(0, 500)
            : null;

          const ackStartedAt = performance.now();
          let ackSucceeded = false;
          let outcome;
          try {
            outcome = await runWithTenantContext({ schoolId: client.schoolId }, () =>
              persistClasspilotCommandTargetAck({
                commandId,
                schoolId: client.schoolId!,
                deviceId: client.deviceId!,
                studentId: client.studentId!,
                studentSessionId: client.studentSessionId!,
                ackState,
                controlRevision: classpilotAckControlRevision(message),
                appliedAuthPolicyRevision:
                  classpilotAckAppliedAuthPolicyRevision(message),
                result: rawResult,
                errorMessage: boundedError,
              })
            );
            ackSucceeded = true;
          } finally {
            recordCommandHotPathPhase(
              "ack_target_update",
              performance.now() - ackStartedAt,
              { success: ackSucceeded }
            );
          }

          if (outcome.target) scheduleCommandUpdate(client.schoolId, commandId);
          if (ackId) {
            ws.send(JSON.stringify({
              type: "command-ack-receipt",
              ...classpilotCommandAckReceipt(ackId, commandId, outcome),
            }));
          }
          return;
        }

        const resolveLiveTarget = async () => {
          if (!client.schoolId || !client.userId) return null;
          const studentId = normalizeClasspilotSignalingIdentifier(
            message.studentId || message.toStudentId
          );
          const teachingSessionId = normalizeClasspilotSignalingIdentifier(
            message.teachingSessionId
          );
          if (!studentId || !teachingSessionId || !client.subscribedSessionIds.has(teachingSessionId)) {
            return null;
          }
          return runWithTenantContext({ schoolId: client.schoolId }, async () => {
            // An admin may subscribe to observe a session, but subscriptions are
            // never mutation authority. Live control/signaling requires immutable
            // primary/co-teacher assignment just like canonical HTTP commands.
            if (!(await isAuthorizedClasspilotSessionStaff(
              client.schoolId!,
              teachingSessionId,
              client.userId!
            ))) {
              return null;
            }
            const [controlState, activeSessions] = await Promise.all([
              getClasspilotStudentControlState(client.schoolId!, studentId),
              getActiveSessionsForStudents(client.schoolId!, [studentId]),
            ]);
            if (controlState?.teachingSessionId !== teachingSessionId) return null;
            const active = activeSessions.find((row) => row.studentId === studentId);
                    return active ? {
                      studentId,
                      teachingSessionId,
                      controlRevision: controlState!.revision,
                      studentSessionId: active.id,
              deviceId: active.deviceId,
            } : null;
          });
        };

        // --- WebRTC signaling: authorized student IDs on the teacher side ---
        if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
          if (!client.schoolId) return;
          const signaling = sanitizeClasspilotSignalingMessage(message.type, message);
          if (!signaling) return;
          if (client.role === "student") {
            if (message.to !== "teacher" || !client.studentId) return;
            const fromStudentId = normalizeClasspilotSignalingIdentifier(client.studentId);
            if (!fromStudentId) return;
            const state = await runWithTenantContext({ schoolId: client.schoolId }, () =>
              getClasspilotStudentControlState(client.schoolId!, client.studentId!)
            );
            const sessionId = normalizeClasspilotSignalingIdentifier(state?.teachingSessionId);
            if (!sessionId) return;
            const negotiationId = String(message.negotiationId || "").trim();
            const requesterUserId = classpilotLiveViewRequester(negotiationId, {
              schoolId: client.schoolId,
              studentId: client.studentId,
              studentSessionId: client.studentSessionId!,
              deviceId: client.deviceId!,
              teachingSessionId: sessionId,
            });
            if (!requesterUserId) return;
            const requesterAuthorized = await runWithTenantContext(
              { schoolId: client.schoolId },
              () => isAuthorizedClasspilotSessionStaff(
                client.schoolId!,
                sessionId,
                requesterUserId
              )
            );
            if (!requesterAuthorized) return;
            const payload = {
              type: message.type,
              from: fromStudentId,
              negotiationId,
              ...signaling,
            };
            sendToStaffUserLocal(client.schoolId, requesterUserId, payload);
            void publishWS({
              kind: "staff-user",
              schoolId: client.schoolId,
              userId: requesterUserId,
            }, payload);
            return;
          }
          const target = await resolveLiveTarget();
          if (!target || !client.userId) return;
          const negotiationId = String(message.negotiationId || "").trim();
          if (!verifyClasspilotLiveViewNegotiation(negotiationId, {
            schoolId: client.schoolId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
            deviceId: target.deviceId,
            teachingSessionId: target.teachingSessionId,
            requesterUserId: client.userId,
          })) return;
          const payload = {
            type: message.type,
            from: "teacher",
            negotiationId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
            ...signaling,
          };
          sendToDeviceLocal(client.schoolId, target.deviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: target.deviceId }, payload);
          return;
        }

        // A student capture/peer failure releases the exact signed claim so a
        // teacher can retry immediately instead of waiting for the live-view
        // lease. The negotiation embeds the original session/requester, so
        // release remains possible after a concurrent classroom scope change.
        if (message.type === "stop-share" && client.role === "student") {
          if (
            message.to !== "teacher"
            || !client.schoolId
            || !client.studentId
            || !client.studentSessionId
            || !client.deviceId
          ) return;
          const negotiationId = String(message.negotiationId || "").trim();
          const authority = classpilotLiveViewNegotiationAuthority(negotiationId, {
            schoolId: client.schoolId,
            studentId: client.studentId,
            studentSessionId: client.studentSessionId,
            deviceId: client.deviceId,
          });
          if (!authority) return;
          await releaseClasspilotLiveViewNegotiation(
            { schoolId: client.schoolId, studentId: client.studentId },
            negotiationId
          );
          const payload = {
            type: "stop-share",
            from: client.studentId,
            negotiationId,
            reason: String(message.reason || "student_stream_stopped").slice(0, 64),
          };
          sendToStaffUserLocal(client.schoolId, authority.requesterUserId, payload);
          void publishWS({
            kind: "staff-user",
            schoolId: client.schoolId,
            userId: authority.requesterUserId,
          }, payload);
          return;
        }

        // --- Remote control: request-stream ---
        if (message.type === "request-stream" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const target = await resolveLiveTarget();
          if (!target || !client.schoolId || !client.userId) return;
          const outcome = await runWithTenantContext({ schoolId: client.schoolId }, () =>
            withClasspilotTeachingTelemetryAuthority({
              schoolId: client.schoolId!,
              teachingSessionId: target.teachingSessionId,
              studentId: target.studentId,
              studentSessionId: target.studentSessionId,
              deviceId: target.deviceId,
              controlRevision: target.controlRevision,
              actorId: client.userId!,
            }, async () => {
              const negotiation = await claimClasspilotLiveViewNegotiation({
                schoolId: client.schoolId!,
                studentId: target.studentId,
                studentSessionId: target.studentSessionId,
                deviceId: target.deviceId,
                teachingSessionId: target.teachingSessionId,
                requesterUserId: client.userId!,
              });
              if (negotiation.status !== "claimed") return {
                status: negotiation.status,
                studentId: target.studentId,
              } as const;
              // Register socket ownership immediately after the claim, before
              // any device delivery or await. If the requester disconnects
              // while Redis coordination is in flight, the closed-socket check
              // below releases the just-created claim without starting capture.
              ownedLiveViewNegotiations.set(negotiation.negotiationId, {
                schoolId: client.schoolId!,
                requesterUserId: client.userId!,
              });
              if (ws.readyState !== WebSocket.OPEN) {
                forgetOwnedLiveView(negotiation.negotiationId);
                await releaseClasspilotLiveViewNegotiation(
                  { schoolId: client.schoolId!, studentId: target.studentId },
                  negotiation.negotiationId
                );
                return { status: "requester_unavailable", studentId: target.studentId } as const;
              }
              const payload = {
                type: "request-stream",
                from: "teacher",
                negotiationId: negotiation.negotiationId,
                teachingSessionId: target.teachingSessionId,
                studentId: target.studentId,
                studentSessionId: target.studentSessionId,
                setupExpiresAt: new Date(
                  Date.now() + CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS
                ).toISOString(),
                expiresAt: new Date(negotiation.expiresAt).toISOString(),
              };
              const deliveredLocally = sendToDeviceLocal(client.schoolId!, target.deviceId, payload);
              const published = await publishWS(
                { kind: "device", schoolId: client.schoolId!, deviceId: target.deviceId },
                payload
              );
              if (!deliveredLocally && !published) {
                forgetOwnedLiveView(negotiation.negotiationId);
                await releaseClasspilotLiveViewNegotiation(
                  { schoolId: client.schoolId!, studentId: target.studentId },
                  negotiation.negotiationId
                );
                return { status: "delivery_unavailable", studentId: target.studentId } as const;
              }
              return {
                status: "claimed",
                studentId: target.studentId,
                teachingSessionId: target.teachingSessionId,
                negotiationId: negotiation.negotiationId,
                expiresAt: negotiation.expiresAt,
                deliveredLocally,
              } as const;
            })
          );
          // Undefined means ownership, exact binding, entitlement, or actor
          // authority changed while the Redis claim was being acquired.
          if (!outcome) return;
          if (outcome.status !== "claimed") {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
              type: outcome.status === "busy" ? "live-view-busy" : "live-view-unavailable",
              code: outcome.status === "busy"
                ? "LIVE_VIEW_BUSY"
                : outcome.status === "delivery_unavailable"
                  ? "LIVE_VIEW_DELIVERY_UNAVAILABLE"
                  : outcome.status === "requester_unavailable"
                    ? "LIVE_VIEW_REQUESTER_UNAVAILABLE"
                  : "LIVE_VIEW_COORDINATION_UNAVAILABLE",
              studentId: outcome.studentId,
            }));
            return;
          }
          if (ws.readyState !== WebSocket.OPEN) {
            stopOwnedLiveViews("requester-disconnected-before-receipt");
            return;
          }
          try {
            ws.send(JSON.stringify({
              type: "live-view-requested",
              studentId: outcome.studentId,
              teachingSessionId: outcome.teachingSessionId,
              negotiationId: outcome.negotiationId,
              setupExpiresAt: new Date(
                Date.now() + CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS
              ).toISOString(),
              expiresAt: new Date(outcome.expiresAt).toISOString(),
              deliveredLocally: outcome.deliveredLocally,
            }));
          } catch {
            stopOwnedLiveViews("requester-receipt-failed");
          }
          return;
        }

        // --- Remote control: stop-share ---
        if (message.type === "stop-share" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const target = await resolveLiveTarget();
          if (!target || !client.schoolId || !client.userId) return;
          const negotiationId = String(message.negotiationId || "").trim();
          if (!verifyClasspilotLiveViewNegotiation(negotiationId, {
            schoolId: client.schoolId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
            deviceId: target.deviceId,
            teachingSessionId: target.teachingSessionId,
            requesterUserId: client.userId,
          })) return;
          const payload = {
            type: "stop-share",
            from: "teacher",
            negotiationId,
            studentId: target.studentId,
            studentSessionId: target.studentSessionId,
          };
          sendToDeviceLocal(client.schoolId, target.deviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: target.deviceId }, payload);
          await releaseClasspilotLiveViewNegotiation(
            { schoolId: client.schoolId, studentId: target.studentId },
            negotiationId
          );
          forgetOwnedLiveView(negotiationId);
          return;
        }
      } catch (error) {
        console.error("[WebSocket] Message error:", safeErrorMetadata(error));
        if (!(error instanceof SyntaxError)) {
          emitWebSocketMetric("WebSocketError");
          errorMonitor.trackError("websocket_error", error, {
            messageType,
            schoolId: client.schoolId,
            userId: client.userId,
          });
        }
      }
    };

    ws.on("message", (data) => {
      if (!consumeClasspilotWsFrame(frameBucket)) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "rate-limit", code: "WS_FRAME_RATE_EXCEEDED" }));
          ws.close(1008, "WebSocket frame rate exceeded");
        }
        return;
      }
      if (pendingFrames >= CLASSPILOT_WS_MAX_PENDING_FRAMES) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "rate-limit", code: "WS_FRAME_QUEUE_EXCEEDED" }));
          ws.close(1008, "WebSocket frame queue exceeded");
        }
        return;
      }
      pendingFrames += 1;
      const processFrame = () => handleMessage(data);
      frameQueue = frameQueue
        .then(processFrame, processFrame)
        .finally(() => { pendingFrames -= 1; });
    });

    ws.on("close", () => {
      stopPingInterval(ws);
      stopOwnedLiveViews("requester-disconnected");
      clearStaffPresence();
      removeWsClient(ws);
      emitWebSocketMetric("WebSocketDisconnect");
      console.log("[WebSocket] Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("[WebSocket] Error:", safeErrorMetadata(error));
      emitWebSocketMetric("WebSocketError");
      errorMonitor.trackError("websocket_error", error);
      stopPingInterval(ws);
      stopOwnedLiveViews("requester-transport-error");
      clearStaffPresence();
      removeWsClient(ws);
    });
  });

  return wss;
}
