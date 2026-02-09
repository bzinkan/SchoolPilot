import "dotenv/config";
import http from "http";
import { createApp } from "./app.js";
import { setupSocketIO } from "./realtime/socketio.js";
import { setupWebSocket } from "./realtime/websocket.js";
import { startScheduler } from "./services/scheduler.js";

const PORT = parseInt(process.env.PORT || "4000", 10);

const app = createApp();
const server = http.createServer(app);

// Attach Socket.io for real-time events (GoPilot dismissal, etc.)
const io = setupSocketIO(server);
console.log("Socket.io attached");

// Attach WebSocket server for ClassPilot device monitoring
setupWebSocket(server);
console.log("WebSocket server attached at /ws");

// Start dismissal auto-start scheduler
startScheduler(io);

server.listen(PORT, () => {
  console.log(`SchoolPilot API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
