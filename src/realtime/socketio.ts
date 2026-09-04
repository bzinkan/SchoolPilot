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
import { WebSocketWorkTracker } from "./websocketWork.js";

let io: Server | null = null;
const SOCKET_CREDENTIAL_REVALIDATION_MS = 30_000;
const socketIoWork = new WebSocketWorkTracker();
const credentialTimers = new Set<ReturnType<typeof setInterval>>();

export function stopSocketIoWork(): void {
  socketIoWork.stop();
  for (const timer of credentialTimers) clearInterval(timer);
  credentialTimers.clear();
}

export function drainSocketIoWork(): Promise<void> { return socketIoWork.drain(); }

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

  io.use((socket, next) => {
    if (!socketIoWork.canStart()) return next(new Error("Authentication service unavailable"));
    return socketIoWork.track((async () => {
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
        if (!socketIoWork.canStart()) return next(new Error("Authentication service unavailable"));
        next();
      } catch {
        next(new Error("Invalid token"));
      }
    })());
  });

  io.on("connection", (socket) => {
    if (!socketIoWork.canStart()) { socket.disconnect(true); return; }
    const userId = socket.data.userId;
    type InitialCredentialState =
      | { ok: true }
      | { ok: false; middlewareError: string };
    let credentialTimer: ReturnType<typeof setInterval> | null = null;
    let credentialCheckRunning = false;
    let authenticatedConnectionLogged = false;
    const disconnectForCredentialChange = (
      message = "Credentials have changed. Sign in again.",
      code = "CREDENTIAL_INVALIDATED"
    ) => {
      if (!socket.connected) return;
      socket.emit("auth:error", { error: message, code });
      socket.disconnect(true);
    };

    // Socket.IO can notify the client that the namespace connected before an
    // async connection callback resumes. Register packet middleware and event
    // listeners synchronously, then gate them on this shared revalidation so a
    // client may safely emit as soon as its `connect` event fires.
    //
    // This second read also closes the race between the namespace middleware's
    // database read and the socket becoming visible to local/Redis credential
    // invalidation handlers. Once it succeeds, either it observed the bump or
    // any later bump can see and disconnect the registered socket.
    const initialCredentialRevalidation = socketIoWork.track((async (): Promise<InitialCredentialState> => {
      try {
        const current = await getUserById(userId);
        if (
          !socket.connected ||
          !current ||
          !credentialVersionMatches(socket.data.authVersion, current.authVersion)
        ) {
          disconnectForCredentialChange();
          return { ok: false, middlewareError: "Credentials invalidated" };
        }
        return { ok: true };
      } catch {
        disconnectForCredentialChange(
          "Authentication service unavailable.",
          "AUTHENTICATION_SERVICE_UNAVAILABLE"
        );
        return { ok: false, middlewareError: "Authentication service unavailable" };
      }
    })());

    socket.use((_event, next) => {
      if (!socketIoWork.canStart()) return next(new Error("Authentication service unavailable"));
      return socketIoWork.track((async () => {
        const initialState = await initialCredentialRevalidation;
        if (!initialState.ok || !socket.connected) {
          return next(new Error(
            initialState.ok ? "Credentials invalidated" : initialState.middlewareError
          ));
        }
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
      })());
    });

    socket.on("join:school", ({ schoolId, homeroomId }) => {
      if (!socketIoWork.canStart()) return;
      return socketIoWork.track((async () => {
        const initialState = await initialCredentialRevalidation;
        if (!initialState.ok || !socket.connected) return;
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
      })());
    });

    socket.on("disconnect", () => {
      if (credentialTimer) {
        clearInterval(credentialTimer);
        credentialTimers.delete(credentialTimer);
      }
      if (authenticatedConnectionLogged) {
        console.log("[Socket.io] Authenticated client disconnected");
      }
    });

    void initialCredentialRevalidation.then((initialState) => {
      if (!socketIoWork.canStart() || !initialState.ok || !socket.connected) return;
      authenticatedConnectionLogged = true;
      console.log("[Socket.io] Authenticated client connected");

      // Redis invalidation is the immediate path. This bounded fallback closes
      // sockets even if a publisher/subscriber was temporarily unavailable, and
      // prevents a stale client from passively receiving room broadcasts forever.
      credentialTimer = setInterval(() => {
        if (!socketIoWork.canStart() || !socket.connected || credentialCheckRunning) return;
        credentialCheckRunning = true;
        void socketIoWork.track((async () => {
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
        })());
      }, SOCKET_CREDENTIAL_REVALIDATION_MS);
      credentialTimers.add(credentialTimer);
      credentialTimer.unref();
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
  void socketIoWork.track(publishSocketIoRedis({ room, event, data }).catch(() => undefined));
}
