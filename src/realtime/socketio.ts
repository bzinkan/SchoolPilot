import { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { credentialVersionMatches, verifyUserToken } from "../services/jwt.js";
import { getUserById } from "../services/storage.js";
import {
  getHomeroomForSchool,
  getTeacherHomeroomIds,
  goPilotIdentityHasAnyRole,
  hasAnyActiveGoPilotStaffMembership,
  hasActiveGoPilotLicense,
  resolveGoPilotIdentity,
} from "../services/gopilotAccess.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  publishSocketIoRedis,
  subscribeSocketIoRedis,
} from "./socketio-redis.js";
import { registerCacheInvalidationHandler } from "./cacheInvalidation.js";

let io: Server | null = null;
const SOCKET_CREDENTIAL_REVALIDATION_MS = 30_000;

registerCacheInvalidationHandler((target) => {
  if (target.cache !== "user-credentials") return;
  for (const socket of io?.sockets.sockets.values() ?? []) {
    if (socket.data.userId !== target.userId) continue;
    socket.emit("auth:error", {
      error: "Credentials have changed. Sign in again.",
      code: "CREDENTIAL_INVALIDATED",
    });
    socket.disconnect(true);
  }
});

function joinValidatedSchoolRoom(socket: Socket, schoolId: string) {
  for (const room of Array.from(socket.rooms)) {
    if (room.startsWith("school:")) {
      socket.leave(room);
    }
  }
  socket.join(`school:${schoolId}`);
}

export function setupSocketIO(httpServer: HttpServer): Server {
  const origins = (process.env.CORS_ALLOWLIST || "http://localhost:3000,http://localhost:5000,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Capacitor native app origins
  for (const o of ["capacitor://localhost", "http://localhost", "https://localhost"]) {
    if (!origins.includes(o)) origins.push(o);
  }

  io = new Server(httpServer, {
    cors: { origin: origins, methods: ["GET", "POST"] },
    path: "/gopilot-socket",
  });

  void subscribeSocketIoRedis(({ room, event, data }) => {
    io?.to(room).emit(event, data);
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));
    try {
      const payload = verifyUserToken(token);
      const user = await getUserById(payload.userId);
      if (!user || !credentialVersionMatches(payload.authVersion, user.authVersion)) {
        return next(new Error("Invalid token"));
      }
      socket.data.userId = payload.userId;
      socket.data.email = payload.email;
      socket.data.isSuperAdmin = user.isSuperAdmin;
      socket.data.authVersion = payload.authVersion ?? 1;
      if (!user.isSuperAdmin && !(await hasAnyActiveGoPilotStaffMembership(payload.userId))) {
        const disabled = new Error("GoPilot parent portal is disabled") as Error & {
          data?: { code: string; status: number };
        };
        disabled.data = {
          code: "GOPILOT_PARENT_PORTAL_DISABLED",
          status: 410,
        };
        return next(disabled);
      }
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    const disconnectForCredentialChange = (
      message = "Credentials have changed. Sign in again.",
      code = "CREDENTIAL_INVALIDATED"
    ) => {
      if (!socket.connected) return;
      socket.emit("auth:error", { error: message, code });
      socket.disconnect(true);
    };

    // Close the handshake race between the middleware's database read and the
    // socket becoming visible to local/Redis invalidation handlers. Once this
    // second read succeeds, either it observed the bump or any later bump can
    // see and disconnect the registered socket.
    try {
      const current = await getUserById(userId);
      if (
        !socket.connected ||
        !current ||
        !credentialVersionMatches(socket.data.authVersion, current.authVersion)
      ) {
        disconnectForCredentialChange();
        return;
      }
    } catch {
      disconnectForCredentialChange(
        "Authentication service unavailable.",
        "AUTHENTICATION_SERVICE_UNAVAILABLE"
      );
      return;
    }

    console.log("[Socket.io] Authenticated client connected");

    // Redis invalidation is the immediate path. This bounded fallback closes
    // sockets even if a publisher/subscriber was temporarily unavailable, and
    // prevents a stale client from passively receiving room broadcasts forever.
    let credentialCheckRunning = false;
    const credentialTimer = setInterval(async () => {
      if (!socket.connected || credentialCheckRunning) return;
      credentialCheckRunning = true;
      try {
        const current = await getUserById(userId);
        if (
          !current ||
          !credentialVersionMatches(socket.data.authVersion, current.authVersion)
        ) {
          disconnectForCredentialChange();
        }
      } catch {
        disconnectForCredentialChange(
          "Authentication service unavailable.",
          "AUTHENTICATION_SERVICE_UNAVAILABLE"
        );
      } finally {
        credentialCheckRunning = false;
      }
    }, SOCKET_CREDENTIAL_REVALIDATION_MS);
    credentialTimer.unref();

    socket.use(async (_event, next) => {
      try {
        const current = await getUserById(userId);
        if (!current || !credentialVersionMatches(socket.data.authVersion, current.authVersion)) {
          disconnectForCredentialChange();
          return next(new Error("Credentials invalidated"));
        }
        return next();
      } catch {
        disconnectForCredentialChange(
          "Authentication service unavailable.",
          "AUTHENTICATION_SERVICE_UNAVAILABLE"
        );
        return next(new Error("Authentication service unavailable"));
      }
    });

    socket.on("join:school", async ({ schoolId, homeroomId }) => {
      try {
        const requestedSchoolId = typeof schoolId === "string" ? schoolId : "";
        if (!requestedSchoolId) {
          socket.emit("join:error", { error: "School context required" });
          return;
        }

        const identity = socket.data.isSuperAdmin
          ? null
          : await resolveGoPilotIdentity(userId, requestedSchoolId);
        if (!socket.data.isSuperAdmin && !identity) {
          socket.emit("join:error", { error: "No access to this school" });
          return;
        }

        const manager = socket.data.isSuperAdmin || !!identity && goPilotIdentityHasAnyRole(
          identity,
          ["admin", "school_admin", "office_staff"]
        );
        const teacher = !!identity && goPilotIdentityHasAnyRole(identity, ["teacher"]);

        if (!manager && !teacher) {
          socket.emit("join:error", {
            error: "GoPilot parent portal is disabled",
            code: "GOPILOT_PARENT_PORTAL_DISABLED",
            status: 410,
          });
          socket.disconnect(true);
          return;
        }

        if (!(await hasActiveGoPilotLicense(requestedSchoolId))) {
          socket.emit("join:error", {
            error: "School is not entitled to GoPilot",
            code: "GOPILOT_NOT_ENTITLED",
          });
          return;
        }

        // Socket.IO handlers run outside Express/ALS, so bind this school's tenant
        // context for the per-school access checks (students/homerooms reads) — RLS
        // would otherwise hide every row and deny legitimate parents/teachers.
        await runWithTenantContext({ schoolId: requestedSchoolId }, async () => {
          if (manager) {
            joinValidatedSchoolRoom(socket, requestedSchoolId);
            socket.join(`school:${requestedSchoolId}:office`);
            return;
          }

          if (teacher) {
            const requestedHomeroomId = typeof homeroomId === "string" ? homeroomId : "";
            if (!requestedHomeroomId) {
              socket.emit("join:error", { error: "Homeroom context required" });
              return;
            }
            const [homeroom, teacherHomeroomIds] = await Promise.all([
              getHomeroomForSchool(requestedHomeroomId, requestedSchoolId),
              getTeacherHomeroomIds(userId, requestedSchoolId),
            ]);
            if (!homeroom || !teacherHomeroomIds.has(requestedHomeroomId)) {
              socket.emit("join:error", { error: "No access to this homeroom" });
              return;
            }
            joinValidatedSchoolRoom(socket, requestedSchoolId);
            socket.join(`school:${requestedSchoolId}:teacher:${requestedHomeroomId}`);
            return;
          }

        });
      } catch {
        socket.emit("join:error", { error: "Failed to join school room" });
      }
    });

    socket.on("disconnect", () => {
      clearInterval(credentialTimer);
      console.log("[Socket.io] Authenticated client disconnected");
    });
  });

  return io;
}

export function getIO(): Server | null {
  return io;
}

/**
 * The sole GoPilot event path. Every producer emits locally for low latency and
 * publishes the same message to Redis for clients attached to other API tasks.
 */
export async function broadcastGoPilot(
  room: string,
  event: string,
  data: unknown
): Promise<void> {
  io?.to(room).emit(event, data);
  // Local delivery is authoritative for request latency. The relay owns
  // bounded connect/publish timeouts and recovery; callers must never block.
  void publishSocketIoRedis({ room, event, data }).catch(() => undefined);
}
