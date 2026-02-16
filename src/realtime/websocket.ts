import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { verifyStudentToken, createStudentToken } from "../services/deviceJwt.js";
import { verifyUserToken } from "../services/jwt.js";
import {
  registerWsClient,
  removeWsClient,
  authenticateWsClient,
  broadcastToTeachersLocal,
  broadcastToStudentsLocal,
  sendToDeviceLocal,
  sendToRoleLocal,
} from "./ws-broadcast.js";
import {
  publishWS,
  subscribeWS,
  type WsRedisTarget,
} from "./ws-redis.js";
import {
  getSchoolByDomain,
  searchStudents,
  createStudent,
  createDevice,
  getDeviceById,
  linkStudentDevice,
  startStudentSession,
  getSettingsForSchool,
} from "../services/storage.js";

// Ping/pong keepalive constants
const WS_PING_INTERVAL_MS = 30_000; // 30 seconds
const WS_PONG_TIMEOUT_MS = 10_000;  // 10 seconds to respond

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
  httpServer.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "/";
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      console.warn("[WebSocket] Failed to parse upgrade URL");
    }

    if (pathname !== "/ws" && pathname !== "/ws/") {
      console.warn("[WebSocket] Rejected upgrade for invalid path:", pathname);
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
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
      try {
        const message = JSON.parse(data.toString());

        // Log non-auth, non-heartbeat messages for debugging
        if (message.type !== "auth" && message.type !== "heartbeat") {
          console.log(
            `[WebSocket] Message received: ${message.type} from ${client.role || "unauthenticated"} (authenticated: ${client.authenticated})`
          );
        }

        // --- Auth handling ---
        if (message.type === "auth") {
          // Student auth via studentToken or email-first auto-provisioning (item #10)
          if (message.role === "student" && message.deviceId) {
            // Token-based auth (primary)
            if (message.studentToken) {
              try {
                const payload = verifyStudentToken(message.studentToken);
                const schoolId = payload.schoolId;
                const deviceId = payload.deviceId;

                authenticateWsClient(ws, {
                  role: "student",
                  deviceId,
                  schoolId,
                });

                // Send settings along with auth success
                const schoolSettings = await getSettingsForSchool(schoolId);
                ws.send(JSON.stringify({
                  type: "auth-success",
                  role: "student",
                  settings: {
                    maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
                      ? parseInt(schoolSettings.maxTabsPerStudent, 10) : null,
                    globalBlockedDomains: schoolSettings?.blockedDomains || [],
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
            }
            // Email-first auto-provisioning (item #10): auth with just email, no prior registration
            else if (message.studentEmail) {
              try {
                const email = message.studentEmail as string;
                const deviceId = message.deviceId as string;
                const domain = email.split("@")[1]?.toLowerCase();
                if (!domain) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Invalid email" }));
                  ws.close();
                  return;
                }

                const school = await getSchoolByDomain(domain);
                if (!school) {
                  ws.send(JSON.stringify({ type: "auth-error", message: "Unknown school domain" }));
                  ws.close();
                  return;
                }

                // Auto-provision student and device
                const existing = await searchStudents(school.id, { search: email });
                let student = existing[0];
                if (!student) {
                  const name = message.studentName || email.split("@")[0];
                  const parts = (name as string).split(/\s+/);
                  student = await createStudent({
                    schoolId: school.id,
                    firstName: parts[0] ?? email.split("@")[0] ?? "Student",
                    lastName: parts.slice(1).join(" ") || "",
                    email,
                    gradeLevel: null,
                    status: "active",
                  });
                }

                let device = await getDeviceById(deviceId);
                if (!device) {
                  device = await createDevice({
                    deviceId,
                    deviceName: null,
                    schoolId: school.id,
                    classId: school.id,
                  });
                }

                await linkStudentDevice({ studentId: student.id, deviceId });
                await startStudentSession(student.id, deviceId);

                const token = createStudentToken({
                  studentId: student.id,
                  deviceId,
                  schoolId: school.id,
                  studentEmail: email,
                });

                authenticateWsClient(ws, {
                  role: "student",
                  deviceId,
                  schoolId: school.id,
                });

                const schoolSettings = await getSettingsForSchool(school.id);
                ws.send(JSON.stringify({
                  type: "auth-success",
                  role: "student",
                  studentToken: token,
                  settings: {
                    maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
                      ? parseInt(schoolSettings.maxTabsPerStudent, 10) : null,
                    globalBlockedDomains: schoolSettings?.blockedDomains || [],
                  },
                }));
                console.log(`[WebSocket] Student auto-provisioned: email=${email}, device=${deviceId}, school=${school.id}`);

                // Notify teachers
                broadcastToTeachersLocal(school.id, {
                  type: "student-registered",
                  studentId: student.id,
                  deviceId,
                  studentEmail: email,
                });
                void publishWS({ kind: "staff", schoolId: school.id }, {
                  type: "student-registered",
                  studentId: student.id,
                  deviceId,
                });
              } catch (error) {
                console.error("[WebSocket] Email-first provisioning error:", error);
                ws.send(JSON.stringify({ type: "auth-error", message: "Auto-provisioning failed" }));
                ws.close();
                return;
              }
            }
            // No token and no email — reject
            else {
              ws.send(JSON.stringify({ type: "auth-error", message: "Student token or email required" }));
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

              // Use the role from the verified JWT payload if available, otherwise trust client
              const role = (message.role as "teacher" | "school_admin" | "super_admin");

              authenticateWsClient(ws, {
                role,
                userId,
                schoolId,
              });

              ws.send(JSON.stringify({ type: "auth-success", role }));
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
        if (message.type === "heartbeat") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // All remaining message types require authentication
        if (!client.authenticated) return;

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
              sendToRoleLocal(client.schoolId, "teacher", payload);
              void publishWS({ kind: "role", schoolId: client.schoolId, role: "teacher" }, payload);
            }
          } else {
            const payload = {
              type: message.type,
              from: client.role === "teacher" ? "teacher" : client.deviceId,
              ...message,
            };
            if (client.schoolId) {
              sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
              void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
            }
          }
        }

        // --- Remote control: request-stream ---
        if (message.type === "request-stream" && (client.role === "teacher" || client.role === "school_admin")) {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId || !client.schoolId) return;

          console.log(`[WebSocket] Forwarding request-stream to ${targetDeviceId}`);
          const payload = { type: "request-stream", from: "teacher" };
          sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
        }

        // --- Remote control: stop-share ---
        if (message.type === "stop-share" && (client.role === "teacher" || client.role === "school_admin")) {
          const targetDeviceId = message.deviceId;
          if (!targetDeviceId || !client.schoolId) return;

          console.log(`[WebSocket] Sending stop-share to ${targetDeviceId}`);
          const payload = { type: "stop-share", from: "teacher" };
          sendToDeviceLocal(client.schoolId, targetDeviceId, payload);
          void publishWS({ kind: "device", schoolId: client.schoolId, deviceId: targetDeviceId }, payload);
        }
      } catch (error) {
        console.error("[WebSocket] Message error:", error);
      }
    });

    ws.on("close", () => {
      stopPingInterval(ws);
      removeWsClient(ws);
      console.log("[WebSocket] Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("[WebSocket] Error:", error);
      stopPingInterval(ws);
      removeWsClient(ws);
    });
  });

  return wss;
}
