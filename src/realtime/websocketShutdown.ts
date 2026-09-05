import type { Server } from "node:http";
import type { Duplex } from "node:stream";

const CLOSE_HANDSHAKE_GRACE_MS = 2_000;

/** Track only HTTP upgrades: raw WebSocket and Socket.IO's Engine.IO transport.
 * Ordinary HTTP requests retain their independent admitted-work drain. */
export function createUpgradedTransportShutdown(server: Server) {
  const sockets = new Set<Duplex>();
  const track = (_request: unknown, socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  };
  server.on("upgrade", track);
  server.once("close", () => { server.off("upgrade", track); });

  // Graceful protocol closes run first. Destroying a transport never resolves
  // admitted application work: callers still await server-close callbacks and
  // then the separate producer tracker, including close-triggered cleanup.
  return async (
    closeServers: () => Promise<void>,
    options: { gracePeriodMs?: number; onForcedClose?: (count: number) => void } = {},
  ): Promise<void> => {
    const timer = setTimeout(() => {
      let terminated = 0;
      for (const socket of sockets) {
        if (socket.destroyed) continue;
        terminated += 1;
        socket.destroy();
      }
      if (terminated > 0) {
        if (options.onForcedClose) options.onForcedClose(terminated);
        else console.log(JSON.stringify({ event: "shutdown_websocket_transport_terminated", connections: terminated }));
      }
    }, options.gracePeriodMs ?? CLOSE_HANDSHAKE_GRACE_MS);
    timer.unref();
    try {
      await closeServers();
    } finally {
      clearTimeout(timer);
    }
  };
}
