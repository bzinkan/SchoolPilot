import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { verifyStudentToken } from "../services/deviceJwt.js";
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
  sendToRoleLocal,
  subscribeWsClientToSession,
  unsubscribeWsClientFromSession,
} from "./ws-broadcast.js";
import {
  publishWS,
  subscribeWS,
  type WsRedisTarget,
} from "./ws-redis.js";
import {
  getSettingsForSchool,
  getMembershipByUserAndSchool,
  getClasspilotCommandByIdAndSchool,
  updateClasspilotCommandTargetAck,
  getTeachingSessionByIdAndSchool,
  getGroupTeachers,
  updateChatMessageDelivery,
  getChatMessageByIdAndSchool,
} from "../services/storage.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { verifyActiveStudentTokenSession } from "../services/classpilotStudentAuth.js";
import { buildStudentFabState } from "../services/classpilotFab.js";
import { startActiveScheduledClassesForTeacher } from "../services/classpilotScheduledStart.js";
import { isClassPilotWebSocketPath, isGoPilotSocketIoPath } from "./websocketPaths.js";

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

export function setupWebSocket(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Track ping/pong state per client
  const clientPingTimers = new Map<WebSocket, NodeJS.Timeout>();
  const clientPongPending = new Map<WebSocket, boolean>();

  // --- Redis cross-instance message delivery ---
  const deliverRedisMessage = (target: WsRedisTarget, message: unknown) => {
    const msgType = (message as { type?: string })?.type ?? "unknown";
    switch (target.kind) {
      case "staff":
        broadcastToTeachersLocal(target.schoolId, message);
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

    console.log("[WebSocket] Client connected");

    // Start ping/pong keepalive
    startPingInterval(ws);

    // Handle pong responses
    ws.on("pong", () => {
      clientPongPending.set(ws, false);
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
              try {
                const payload = verifyStudentToken(message.studentToken);
                const schoolId = payload.schoolId;
                const deviceId = payload.deviceId;
                const hasActiveSession = await runWithTenantContext(
                  { schoolId },
                  () => verifyActiveStudentTokenSession(payload)
                );
                if (!hasActiveSession) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Student session is no longer active" }));
                  ws.close();
                  return;
                }

                authenticateWsClient(ws, {
                  role: "student",
                  deviceId,
                  schoolId,
                });

                // Send settings along with auth success
                const schoolSettings = await runWithTenantContext({ schoolId }, () => getSettingsForSchool(schoolId));
                const fab = await runWithTenantContext({ schoolId }, () =>
                  buildStudentFabState(schoolId, payload.studentId)
                );
                ws.send(JSON.stringify({
                  type: "auth-success",
                  role: "student",
                  settings: {
                    maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
                      ? parseInt(schoolSettings.maxTabsPerStudent, 10) : null,
                    globalBlockedDomains: schoolSettings?.blockedDomains || [],
                    fab,
                  },
                }));
                console.log(`[WebSocket] Student authenticated: device=${deviceId}, school=${schoolId}`);
              } catch (error) {
                const msg = error instanceof Error && error.name === "TokenExpiredError"
                  ? "Token expired, please re-register"
                  : "Invalid token";
                ws.send(JSON.stringify({ type: "auth-error", message: msg }));
                ws.close();
                return;
              }
            } else {
              ws.send(JSON.stringify({ type: "auth-error", message: "Student token required" }));
              ws.close();
              return;
            }
          }

          // Staff auth via userToken (JWT-based, no session dependency)
          if (message.role === "teacher" || message.role === "school_admin" || message.role === "super_admin") {
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
              let role: "teacher" | "school_admin" | "super_admin" = "teacher";
              if (payload.isSuperAdmin) {
                role = "super_admin";
              } else {
                const membership = await getMembershipByUserAndSchool(userId, schoolId);
                if (!membership) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "No access to this school" }));
                  ws.close();
                  return;
                }
                role = membership.role === "admin" || membership.role === "school_admin" ? "school_admin" : "teacher";
              }

              authenticateWsClient(ws, {
                role,
                userId,
                schoolId,
              });

              ws.send(JSON.stringify({ type: "auth-success", role }));
              void runWithTenantContext({ schoolId }, async () => {
                const started = await startActiveScheduledClassesForTeacher({ schoolId, teacherId: userId });
                if (started.length > 0) {
                  broadcastToTeachersLocal(schoolId, {
                    type: "scheduled-class-conflict-updated",
                    startedSessionIds: started.map((session) => session.id),
                  });
                }
              }).catch((error) => {
                console.error("[WebSocket] Scheduled class pickup on staff login failed:", error);
                errorMonitor.trackError("scheduler_failure", error as Error, {
                  job: "scheduledClassLoginPickup",
                  schoolId,
                  teacherId: userId,
                });
              });
              console.log(`[WebSocket] Staff authenticated: ${role} (userId: ${userId})`);
            } catch (error) {
              console.error("[WebSocket] Staff auth error:", error);
              ws.send(JSON.stringify({ type: "auth-error", message: "Authentication failed" }));
              ws.close();
              return;
            }
          }
        }

        // --- Heartbeat handling ---
        if (message.type === "heartbeat" || message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // All remaining message types require authentication
        if (!client.authenticated) return;

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
            if (session.teacherId === client.userId) return true;
            const teachers = await getGroupTeachers(session.groupId);
            return teachers.some((teacher) => teacher.teacherId === client.userId);
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
              deviceId: client.deviceId,
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
          client.role === "student" &&
          client.schoolId &&
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
            : rawAckState === "completed" || rawAckState === "success"
              ? "completed"
              : rawAckState === "received"
                ? "received"
                : null;

          if (!commandId || !ackState) return;

          const command = await runWithTenantContext({ schoolId: client.schoolId }, async () => {
            await updateClasspilotCommandTargetAck({
              commandId,
              schoolId: client.schoolId!,
              deviceId: client.deviceId!,
              studentId: message.studentId ? String(message.studentId) : undefined,
              ackState,
              result: message.result || message.state || message.data || null,
              errorMessage: message.error || message.errorMessage || null,
            });
            return getClasspilotCommandByIdAndSchool(commandId, client.schoolId!);
          });

          if (command) {
            const payload = {
              type: "classpilot-command-update",
              commandId,
              command,
            };
            broadcastToTeachersLocal(client.schoolId, payload);
            void publishWS({ kind: "staff", schoolId: client.schoolId }, payload);
          }
          return;
        }

        // --- WebRTC signaling: offer, answer, ice ---
        if (message.type === "offer" || message.type === "answer" || message.type === "ice") {
          const targetDeviceId = message.to;
          if (!targetDeviceId) {
            console.log(`[WebSocket] Dropping ${message.type} - missing 'to' field`);
            return;
          }

          console.log(`[WebSocket] Routing ${message.type} between clients`);

          if (targetDeviceId === "teacher") {
            const payload = {
              type: message.type,
              from: client.deviceId,
              ...message,
            };
            if (client.schoolId) {
              broadcastToTeachersLocal(client.schoolId, payload);
              void publishWS({ kind: "staff", schoolId: client.schoolId }, payload);
            }
          } else {
            const payload = {
              type: message.type,
              from: client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin" ? "teacher" : client.deviceId,
              ...message,
            };
            if (client.schoolId) {
              sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
              void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
            }
          }
        }

        // --- Remote control: request-stream ---
        if (message.type === "request-stream" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId || !client.schoolId) return;

          console.log(`[WebSocket] Forwarding request-stream to ${targetDeviceId}`);
          const payload = { type: "request-stream", from: "teacher" };
          const deliveredLocally = sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
          ws.send(JSON.stringify({
            type: "live-view-requested",
            deviceId: targetDeviceId,
            deliveredLocally,
          }));
        }

        // --- Remote control: stop-share ---
        if (message.type === "stop-share" && (client.role === "teacher" || client.role === "school_admin" || client.role === "super_admin")) {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId || !client.schoolId) return;

          console.log(`[WebSocket] Sending stop-share to ${targetDeviceId}`);
          const payload = { type: "stop-share", from: "teacher" };
          sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
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
      removeWsClient(ws);
      emitWebSocketMetric("WebSocketDisconnect");
      console.log("[WebSocket] Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("[WebSocket] Error:", error);
      emitWebSocketMetric("WebSocketError");
      errorMonitor.trackError("websocket_error", error);
      stopPingInterval(ws);
      removeWsClient(ws);
    });
  });

  return wss;
}
