import { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { verifyUserToken } from "../services/jwt.js";

let io: Server | null = null;

export function setupSocketIO(httpServer: HttpServer): Server {
  const origins = (process.env.CORS_ALLOWLIST || "http://localhost:3000,http://localhost:5000,http://localhost:5173").split(",");

  io = new Server(httpServer, {
    cors: { origin: origins, methods: ["GET", "POST"] },
    path: "/gopilot-socket",
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));
    try {
      const payload = verifyUserToken(token);
      socket.data.userId = payload.userId;
      socket.data.email = payload.email;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    console.log(`[Socket.io] Connected: user ${userId}`);

    socket.on("join:school", ({ schoolId, role, homeroomId }) => {
      if (role === "admin" || role === "office_staff") {
        socket.join(`school:${schoolId}:office`);
      }
      if (role === "teacher" && homeroomId) {
        socket.join(`school:${schoolId}:teacher:${homeroomId}`);
      }
      if (role === "parent") {
        socket.join(`school:${schoolId}:parent:${userId}`);
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
