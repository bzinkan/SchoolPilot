import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { randomUUID } from "crypto";
import {
  InvalidTokenError,
  TokenExpiredError,
  verifyStudentToken,
  type StudentTokenPayload,
} from "../services/deviceJwt.js";
import { verifyUserToken } from "../services/jwt.js";
import errorMonitor from "../services/errorMonitor.js";
import {
  registerWsClient,
  removeWsClient,
  authenticateWsClient,
  broadcastToTeachersLocal,
  broadcastToStaffSessionLocal,
  broadcastToStudentsLocal,
  sendToDeviceLocal,
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
  getMembershipByUserAndSchool,
  updateClasspilotCommandSummary,
  withClasspilotCommandBroadcastLock,
  updateClasspilotCommandTargetAck,
  getTeachingSessionByIdAndSchool,
  isAuthorizedClasspilotSessionStaff,
  getClasspilotStudentControlState,
  getActiveSessionsForStudents,
  acknowledgeClasspilotStudentControlState,
  updateChatMessageDelivery,
  getChatMessageByIdAndSchool,
} from "../services/storage.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  resolveActiveStudentTokenSession,
  studentAuthenticationServiceError,
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
import { serializeClasspilotStudentControlState } from "../services/classpilotClassroomState.js";
import { publicClasspilotCommand } from "../services/classpilotCommandPublic.js";
import {
  classpilotCommandDeliveryPolicy,
  summarizeClasspilotCommandTargets,
} from "../services/classpilotCommandDelivery.js";

// Ping/pong keepalive constants
const WS_PING_INTERVAL_MS = 30_000; // 30 seconds
const WS_PONG_TIMEOUT_MS = 10_000;  // 10 seconds to respond

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
) => Promise<unknown | undefined>;

/**
 * Revalidate the exact persisted student/session/device binding for an already
 * authenticated socket. Student lifecycle changes end the persisted session;
 * checking it again before every student-originating message prevents a socket
 * that was open during roster removal from acknowledging commands, mutating
 * chat delivery, or sending WebRTC signaling afterward.
 */
export async function hasActiveStudentWebSocketBinding(
  client: Pick<
    WSClient,
    "role" | "schoolId" | "studentId" | "studentSessionId" | "deviceId"
  >,
  resolveSession: StudentWebSocketSessionResolver = (payload) =>
    runWithTenantContext({ schoolId: payload.schoolId }, () =>
      resolveActiveStudentTokenSession(payload)
    )
): Promise<boolean> {
  if (client.role !== "student") return true;
  if (
    !client.schoolId ||
    !client.studentId ||
    !client.studentSessionId ||
    !client.deviceId
  ) {
    return false;
  }
  return Boolean(await resolveSession({
    schoolId: client.schoolId,
    studentId: client.studentId,
    sessionId: client.studentSessionId,
    deviceId: client.deviceId,
  }));
}

type StaffMembershipResolver = (
  userId: string,
  schoolId: string
) => Promise<{ role: string } | undefined>;

function staffWebSocketRole(membershipRole: string): Exclude<WsRole, "student"> | null {
  if (membershipRole === "admin" || membershipRole === "school_admin") return "school_admin";
  if (membershipRole === "teacher") return "teacher";
  if (membershipRole === "office_staff") return "office_staff";
  return null;
}

/** Revalidate the current active membership before retaining staff authority. */
export async function activeStaffWebSocketRole(
  client: Pick<WSClient, "role" | "schoolId" | "userId">,
  resolveMembership: StaffMembershipResolver = getMembershipByUserAndSchool
): Promise<Exclude<WsRole, "student"> | null> {
  if (client.role === "super_admin") return "super_admin";
  if (!client.schoolId || !client.userId || client.role === "student") return null;
  const membership = await resolveMembership(client.userId, client.schoolId);
  return membership ? staffWebSocketRole(membership.role) : null;
}

export function setupWebSocket(
  httpServer: Server,
  options: { presenceStore?: ClasspilotStaffPresenceStore } = {}
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const presenceStore = options.presenceStore ?? classpilotStaffPresenceStore;

  let activity = { connected: 0, studentAuthenticated: 0, staffAuthenticated: 0 };
  const activityTimer = setInterval(() => {
    const snapshot = activity;
    activity = { connected: 0, studentAuthenticated: 0, staffAuthenticated: 0 };
    if (snapshot.connected === 0 && snapshot.studentAuthenticated === 0 && snapshot.staffAuthenticated === 0) return;
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

  wss.once("close", () => {
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
        console.log(`[Redis] Delivering ${msgType} to device ${target.deviceId}`);
        sendToDeviceLocal(target.schoolId, target.deviceId, message);
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
      console.warn("[WebSocket] Rejected upgrade for invalid path:", pathname);
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Validate origin in production (allow Chrome extensions which send chrome-extension:// origin)
    const origin = request.headers.origin;
    const isExtensionOrigin = origin?.startsWith("chrome-extension://");
    if (wsAllowlist.length > 0 && origin && !isExtensionOrigin && !wsAllowlist.includes(origin)) {
      console.warn("[WebSocket] Rejected upgrade from unauthorized origin:", origin);
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
        clearInterval(timer);
        clientPingTimers.delete(ws);
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
    }, WS_PING_INTERVAL_MS);

    clientPingTimers.set(ws, timer);
  }

  function stopPingInterval(ws: WebSocket) {
    const timer = clientPingTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      clientPingTimers.delete(ws);
    }
    clientPongPending.delete(ws);
  }

  // --- Connection handler ---
  wss.on("connection", (ws) => {
    const client = registerWsClient(ws);
    let studentPongRevalidation: Promise<void> | null = null;
    let staffPongRevalidation: Promise<void> | null = null;
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
    activity.connected += 1;

    // Start ping/pong keepalive
    startPingInterval(ws);

    // Handle pong responses
    ws.on("pong", () => {
      clientPongPending.set(ws, false);
      refreshStaffPresence();
      if (!client.authenticated) return;
      if (client.role === "student") {
        if (studentPongRevalidation || !client.schoolId || !client.studentId) return;
        const binding = {
          role: client.role,
          schoolId: client.schoolId,
          studentId: client.studentId,
          studentSessionId: client.studentSessionId,
          deviceId: client.deviceId,
        } as const;
        const pending = hasActiveStudentWebSocketBinding(binding)
          .then((active) => {
            if (
              client.schoolId !== binding.schoolId ||
              client.studentId !== binding.studentId ||
              client.studentSessionId !== binding.studentSessionId ||
              client.deviceId !== binding.deviceId
            ) {
              return;
            }
            if (!active) closeStudentSocketsLocal(binding.schoolId, [binding.studentId]);
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
      if (client.role === "super_admin" || staffPongRevalidation) return;
      const binding = { role: client.role, schoolId: client.schoolId, userId: client.userId } as const;
      const pending = activeStaffWebSocketRole(binding)
        .then((currentRole) => {
          if (
            client.schoolId !== binding.schoolId ||
            client.userId !== binding.userId ||
            client.role !== binding.role
          ) {
            return;
          }
          if (currentRole !== binding.role) {
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

    ws.on("message", async (data) => {
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

              try {
                const schoolId = payload.schoolId;
                const deviceId = payload.deviceId;
                const bootstrap = await runWithTenantContext({ schoolId }, async () => {
                  const activeSession = await resolveActiveStudentTokenSession(payload);
                  if (!activeSession) return null;
                  const schoolSettings = await getSettingsForSchool(schoolId);
                  const fab = await buildStudentFabState(schoolId, payload.studentId, {
                    schoolSettings,
                  });
                  const classroomStateRow = await getClasspilotStudentControlState(schoolId, payload.studentId);
                  return {
                    schoolSettings,
                    fab,
                    studentSessionId: activeSession.id,
                    classroomState: classroomStateRow
                      ? serializeClasspilotStudentControlState(classroomStateRow)
                      : null,
                  };
                });
                if (!bootstrap) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Student session is no longer active" }));
                  ws.close();
                  return;
                }

                clearStaffPresence();
                authenticateWsClient(ws, {
                  role: "student",
                  deviceId,
                  schoolId,
                  studentId: payload.studentId,
                  studentSessionId: bootstrap.studentSessionId,
                });

                ws.send(JSON.stringify({
                  type: "auth-success",
                  role: "student",
                  settings: {
                    maxTabsPerStudent: bootstrap.schoolSettings?.maxTabsPerStudent
                      ? parseInt(bootstrap.schoolSettings.maxTabsPerStudent, 10) : null,
                    globalBlockedDomains: bootstrap.schoolSettings?.blockedDomains || [],
                    fab: bootstrap.fab,
                  },
                  // Explicit null is authoritative on shared Chromebooks. If
                  // the new student has no desired row, omitting the field
                  // would leave the former student's persisted restrictions.
                  classroomState: bootstrap.classroomState,
                }));
                activity.studentAuthenticated += 1;
              } catch (error) {
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

              if (!schoolId) {
                ws.send(JSON.stringify({ type: "auth-error", message: "School context required" }));
                ws.close();
                return;
              }

              // Verify role from DB membership instead of trusting client
              let role: "teacher" | "office_staff" | "school_admin" | "super_admin";
              if (payload.isSuperAdmin) {
                role = "super_admin";
              } else {
                const membership = await getMembershipByUserAndSchool(userId, schoolId);
                if (!membership) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "No access to this school" }));
                  ws.close();
                  return;
                }
                const currentRole = staffWebSocketRole(membership.role);
                if (!currentRole) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Staff access required" }));
                  ws.close(1008, "Staff access required");
                  return;
                }
                role = currentRole;
              }

              authenticateWsClient(ws, {
                role,
                userId,
                schoolId,
              });

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
                  const started = await startActiveScheduledClassesForTeacher({ schoolId, teacherId: userId });
                  if (started.length > 0) {
                    broadcastScheduledClassUpdate(schoolId, {
                      type: "scheduled-class-conflict-updated",
                      startedSessionIds: started.map((session) => session.id),
                    });
                  }
                })
              ).catch((error) => {
                console.error("[WebSocket] Scheduled class pickup on staff login failed:", error);
                errorMonitor.trackError("scheduler_failure", error as Error, {
                  job: "scheduledClassLoginPickup",
                  schoolId,
                  teacherId: userId,
                });
              });
            } catch (error) {
              console.error("[WebSocket] Staff auth error:", error);
              ws.send(JSON.stringify({ type: "auth-error", message: "Authentication failed" }));
              ws.close();
              return;
            }
          }
        }

        // Every post-authentication message requires a current persisted role;
        // a cached teacher role must not survive demotion or deactivation.
        if (!client.authenticated) return;
        if (
          client.role !== "student" &&
          client.role !== "super_admin" &&
          message.type !== "auth"
        ) {
          try {
            const currentRole = await activeStaffWebSocketRole(client);
            if (currentRole !== client.role) {
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

        // --- Heartbeat handling ---
        if (message.type === "heartbeat" || message.type === "ping") {
          refreshStaffPresence();
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // Authentication is not a one-time authorization grant. Deactivating a
        // student ends the backing device session, so every subsequent
        // student-originating message must prove that exact binding is still
        // active before any chat/classroom/ack/WebRTC mutation can run.
        if (client.role === "student" && message.type !== "auth") {
          try {
            if (!(await hasActiveStudentWebSocketBinding(client))) {
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

        // --- Staff session subscriptions for session-scoped FAB events ---
        if (
          (message.type === "subscribe-session" || message.type === "unsubscribe-session") &&
          client.schoolId &&
          (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")
        ) {
          const sessionId = String(message.sessionId || message.teachingSessionId || "").trim();
          if (!sessionId) {
            ws.send(JSON.stringify({ type: "session-subscription-error", error: "sessionId required" }));
            return;
          }

          const allowed = await runWithTenantContext({ schoolId: client.schoolId }, async () => {
            const session = await getTeachingSessionByIdAndSchool(sessionId, client.schoolId!);
            if (!session) return false;
            if (client.role === "school_admin" || client.role === "super_admin") return true;
            return isAuthorizedClasspilotSessionStaff(
              client.schoolId!,
              sessionId,
              client.userId!
            );
          });

          if (!allowed) {
            ws.send(JSON.stringify({ type: "session-subscription-error", sessionId, error: "Session not found" }));
            return;
          }

          if (message.type === "subscribe-session") {
            subscribeWsClientToSession(ws, sessionId);
            ws.send(JSON.stringify({ type: "session-subscription-success", sessionId }));
          } else {
            unsubscribeWsClientFromSession(ws, sessionId);
            ws.send(JSON.stringify({ type: "session-unsubscription-success", sessionId }));
          }
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

          const chatMessage = await runWithTenantContext({ schoolId: client.schoolId }, async () => {
            await updateChatMessageDelivery({
              messageId,
              schoolId: client.schoolId!,
              deviceId: client.deviceId!,
              deliveryStatus,
              errorMessage: message.error || message.errorMessage || null,
            });
            return getChatMessageByIdAndSchool(messageId, client.schoolId!);
          });

          if (chatMessage?.sessionId) {
            const payload = {
              type: "chat-message-delivery",
              sessionId: chatMessage.sessionId,
              messageId,
              studentId: chatMessage.studentId,
              deliveryStatus,
              errorMessage: message.error || message.errorMessage || null,
            };
            broadcastToStaffSessionLocal(client.schoolId, chatMessage.sessionId, payload);
            void publishWS({ kind: "staff-session", schoolId: client.schoolId, sessionId: chatMessage.sessionId }, payload);
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
            await runWithTenantContext({ schoolId: client.schoolId }, () =>
              acknowledgeClasspilotStudentControlState({
                schoolId: client.schoolId!,
                studentId: client.studentId!,
                studentSessionId: client.studentSessionId!,
                deviceId: client.deviceId!,
                appliedRevision,
                outcome,
                error: message.error ? String(message.error) : null,
              })
            );
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
            async () => {
              const activeSessions = await getActiveSessionsForStudents(
                client.schoolId!,
                [client.studentId!]
              );
              const exactBindingIsActive = activeSessions.some((session) =>
                session.id === client.studentSessionId
                && session.studentId === client.studentId
                && session.deviceId === client.deviceId
              );
              if (!exactBindingIsActive) return { active: false as const, state: null };
              const state = await getClasspilotStudentControlState(
                client.schoolId!,
                client.studentId!
              );
              return {
                active: true as const,
                state: state ? serializeClasspilotStudentControlState(state) : null,
              };
            }
          );
          if (!reconciliation.active) {
            ws.send(JSON.stringify({ type: "auth-error", message: "Student session is no longer active" }));
            ws.close();
            return;
          }
          ws.send(JSON.stringify({
            type: "classroom-state-sync",
            classroomState: reconciliation.state,
          }));
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

          if (!commandId || !ackState) return;
          const rawResult = message.result || message.state || message.data || null;
          const serializedResult = rawResult === null ? null : JSON.stringify(rawResult);
          if (serializedResult && Buffer.byteLength(serializedResult, "utf8") > 16 * 1024) {
            return;
          }
          const boundedError = message.error || message.errorMessage
            ? String(message.error || message.errorMessage).slice(0, 500)
            : null;

          const ackStartedAt = performance.now();
          let ackSucceeded = false;
          let target;
          try {
            target = await runWithTenantContext({ schoolId: client.schoolId }, () =>
              updateClasspilotCommandTargetAck({
                commandId,
                schoolId: client.schoolId!,
                deviceId: client.deviceId!,
                studentId: client.studentId!,
                studentSessionId: client.studentSessionId!,
                ackState,
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

          if (target) scheduleCommandUpdate(client.schoolId, commandId);
          return;
        }

        const resolveLiveTarget = async () => {
          if (!client.schoolId || !client.userId) return null;
          const studentId = String(message.studentId || message.toStudentId || "").trim();
          const teachingSessionId = String(message.teachingSessionId || "").trim();
          if (!studentId || !teachingSessionId || !client.subscribedSessionIds.has(teachingSessionId)) {
            return null;
          }
          return runWithTenantContext({ schoolId: client.schoolId }, async () => {
            const [controlState, activeSessions] = await Promise.all([
              getClasspilotStudentControlState(client.schoolId!, studentId),
              getActiveSessionsForStudents(client.schoolId!, [studentId]),
            ]);
            if (controlState?.teachingSessionId !== teachingSessionId) return null;
            const active = activeSessions.find((row) => row.studentId === studentId);
            return active ? { studentId, teachingSessionId, deviceId: active.deviceId } : null;
          });
        };

        // --- WebRTC signaling: authorized student IDs on the teacher side ---
        if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
          if (!client.schoolId) return;
          if (client.role === "student") {
            if (message.to !== "teacher" || !client.studentId) return;
            const state = await runWithTenantContext({ schoolId: client.schoolId }, () =>
              getClasspilotStudentControlState(client.schoolId!, client.studentId!)
            );
            const sessionId = state?.teachingSessionId;
            if (!sessionId) return;
            const payload = {
              type: message.type,
              from: client.studentId,
              ...(message.sdp ? { sdp: message.sdp } : {}),
              ...(message.candidate ? { candidate: message.candidate } : {}),
            };
            broadcastToStaffSessionLocal(client.schoolId, sessionId, payload);
            void publishWS({ kind: "staff-session", schoolId: client.schoolId, sessionId }, payload);
            return;
          }
          const target = await resolveLiveTarget();
          if (!target) return;
          const payload = {
            type: message.type,
            from: "teacher",
            ...(message.sdp ? { sdp: message.sdp } : {}),
            ...(message.candidate ? { candidate: message.candidate } : {}),
          };
          sendToDeviceLocal(client.schoolId, target.deviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: target.deviceId }, payload);
          return;
        }

        // --- Remote control: request-stream ---
        if (message.type === "request-stream" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const target = await resolveLiveTarget();
          if (!target || !client.schoolId) return;
          const payload = { type: "request-stream", from: "teacher" };
          const deliveredLocally = sendToDeviceLocal(client.schoolId, target.deviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: target.deviceId }, payload);
          ws.send(JSON.stringify({
            type: "live-view-requested",
            studentId: target.studentId,
            deliveredLocally,
          }));
          return;
        }

        // --- Remote control: stop-share ---
        if (message.type === "stop-share" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const target = await resolveLiveTarget();
          if (!target || !client.schoolId) return;
          const payload = { type: "stop-share", from: "teacher" };
          sendToDeviceLocal(client.schoolId, target.deviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: target.deviceId }, payload);
          return;
        }
      } catch (error) {
        console.error("[WebSocket] Message error:", error);
        if (!(error instanceof SyntaxError)) {
          emitWebSocketMetric("WebSocketError");
          errorMonitor.trackError("websocket_error", error, {
            messageType,
            schoolId: client.schoolId,
            userId: client.userId,
          });
        }
      }
    });

    ws.on("close", () => {
      stopPingInterval(ws);
      clearStaffPresence();
      removeWsClient(ws);
      emitWebSocketMetric("WebSocketDisconnect");
      console.log("[WebSocket] Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("[WebSocket] Error:", error);
      emitWebSocketMetric("WebSocketError");
      errorMonitor.trackError("websocket_error", error);
      stopPingInterval(ws);
      clearStaffPresence();
      removeWsClient(ws);
    });
  });

  return wss;
}
