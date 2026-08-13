import { createServer } from "node:http";
import {
  broadcastGoPilot,
  getIO,
  setupSocketIO,
} from "../../src/realtime/socketio.js";
import {
  closeSocketIoRedis,
  getSocketIoRedisHealth,
} from "../../src/realtime/socketio-redis.js";
import { pool } from "../../src/db.js";

type ParentCommand =
  | {
      id: string;
      type: "broadcast";
      room: string;
      event: string;
      data: unknown;
    }
  | { id: string; type: "inspect-room"; room: string }
  | { id: string; type: "shutdown" };

const httpServer = createServer((_request, response) => {
  response.writeHead(404).end();
});
const socketServer = setupSocketIO(httpServer);
let shuttingDown = false;

function send(message: unknown): void {
  if (process.connected) process.send?.(message);
}

async function waitForRelaySubscription(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const health = getSocketIoRedisHealth();
    if (health.configured && health.connected && health.subscribed && health.healthy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("GoPilot Redis relay did not become ready");
}

async function closeHttpServer(): Promise<void> {
  if (!httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function shutdown(id?: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  await closeHttpServer();
  await closeSocketIoRedis();
  await pool.end();

  const relay = getSocketIoRedisHealth();
  send({
    id,
    type: "shutdown-complete",
    state: {
      httpListening: httpServer.listening,
      socketCount: getIO()?.sockets.sockets.size ?? 0,
      redisConnected: relay.connected,
      redisSubscribed: relay.subscribed,
    },
  });
  process.disconnect?.();
}

process.on("message", (rawMessage: ParentCommand) => {
  void (async () => {
    try {
      if (rawMessage.type === "broadcast") {
        await broadcastGoPilot(rawMessage.room, rawMessage.event, rawMessage.data);
        send({ id: rawMessage.id, type: "response", ok: true });
        return;
      }

      if (rawMessage.type === "inspect-room") {
        send({
          id: rawMessage.id,
          type: "response",
          ok: true,
          result: {
            size: getIO()?.sockets.adapter.rooms.get(rawMessage.room)?.size ?? 0,
          },
        });
        return;
      }

      await shutdown(rawMessage.id);
    } catch (error) {
      send({
        id: rawMessage.id,
        type: "response",
        ok: false,
        error: error instanceof Error ? error.message : "Fixture command failed",
      });
    }
  })();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}

httpServer.listen(0, "127.0.0.1", () => {
  void (async () => {
    try {
      await waitForRelaySubscription();
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Fixture server did not bind an IP port");
      }
      send({ type: "ready", port: address.port });
    } catch (error) {
      send({
        type: "fatal",
        error: error instanceof Error ? error.message : "Fixture startup failed",
      });
      process.exitCode = 1;
      await shutdown();
    }
  })();
});
