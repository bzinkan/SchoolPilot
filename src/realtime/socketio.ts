import { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { verifyUserToken } from "../services/jwt.js";
import { getUserById } from "../services/storage.js";
import {
  effectiveGoPilotRole,
  getGoPilotMembership,
  getApprovedParentStudentIds,
  getHomeroomForSchool,
  getTeacherHomeroomIds,
  hasActiveGoPilotLicense,
  isGoPilotManager,
} from "../services/gopilotAccess.js";

let io: Server | null = null;

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

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));
    try {
      const payload = verifyUserToken(token);
      const user = await getUserById(payload.userId);
      if (!user) return next(new Error("Invalid token"));
      socket.data.userId = payload.userId;
      socket.data.email = payload.email;
      socket.data.isSuperAdmin = user.isSuperAdmin;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    console.log(`[Socket.io] Connected: user ${userId}`);

    socket.on("join:school", async ({ schoolId, homeroomId }) => {
      try {
        const requestedSchoolId = typeof schoolId === "string" ? schoolId : "";
        if (!requestedSchoolId) {
          socket.emit("join:error", { error: "School context required" });
          return;
        }

        if (!socket.data.isSuperAdmin && !(await hasActiveGoPilotLicense(requestedSchoolId))) {
          socket.emit("join:error", { error: "Product license required" });
          return;
        }

        const membership = socket.data.isSuperAdmin
          ? null
          : await getGoPilotMembership(userId, requestedSchoolId);
        if (!socket.data.isSuperAdmin && !membership) {
          socket.emit("join:error", { error: "No access to this school" });
          return;
        }

        const role = socket.data.isSuperAdmin
          ? "super_admin"
          : effectiveGoPilotRole(membership!);

        socket.join(`school:${requestedSchoolId}`);

        if (isGoPilotManager(role)) {
          socket.join(`school:${requestedSchoolId}:office`);
          return;
        }

        if (role === "teacher") {
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
          socket.join(`school:${requestedSchoolId}:teacher:${requestedHomeroomId}`);
          return;
        }

        if (role === "parent") {
          // Only parents with at least one APPROVED child at this school may
          // join the broadcast parent room — a membership alone isn't enough.
          const approved = await getApprovedParentStudentIds(userId, requestedSchoolId);
          if (approved.size === 0) {
            socket.emit("join:error", { error: "No approved children at this school" });
            return;
          }
          socket.join(`school:${requestedSchoolId}:parent:${userId}`);
          socket.join(`school:${requestedSchoolId}:parents`);
        }
      } catch {
        socket.emit("join:error", { error: "Failed to join school room" });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.io] Disconnected: user ${userId}`);
    });
  });

  return io;
}

export function getIO(): Server | null {
  return io;
}
