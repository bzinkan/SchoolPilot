import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  authenticateWsClient,
  getWsClient,
  registerWsClient,
} from "../src/realtime/ws-broadcast.js";
import { dispatchCacheInvalidation } from "../src/realtime/cacheInvalidation.js";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("staff identity repair releases its lazily loaded realtime runtime", async () => {
  const [repairCli, cacheBus, wsRedis] = await Promise.all([
    read("src/cli/repairClasspilotStaffIdentity.ts"),
    read("src/realtime/cacheInvalidation.ts"),
    read("src/realtime/ws-redis.ts"),
  ]);

  assert.match(repairCli, /disposeCacheInvalidationPublisher\(\)/);
  assert.match(repairCli, /disposeAndWait\(\)/);
  const cleanup = repairCli.slice(
    repairCli.lastIndexOf("} finally {"),
    repairCli.indexOf("const invokedPath")
  );
  assert.ok(cleanup.indexOf("disposeAndWait()") < cleanup.indexOf("pool.end()"));
  assert.match(cacheBus, /publisherDisposer/);
  assert.match(wsRedis, /export async function disposeWSRedis\(\)/);
  assert.match(
    wsRedis,
    /registerCacheInvalidationPublisher\([\s\S]*?disposeWSRedis\s*\)/
  );
  assert.doesNotMatch(
    wsRedis.slice(0, wsRedis.indexOf("export async function getScreenshots")),
    /middleware\/rateLimiter/
  );
  assert.match(
    wsRedis.slice(wsRedis.indexOf("export async function getScreenshots")),
    /await import\("\.\.\/middleware\/rateLimiter\.js"\)/
  );
});

test("staff credential invalidation disconnects realtime clients on every API instance", async () => {
  const [cacheBus, socketIo, webSocket, wsBroadcast] = await Promise.all([
    read("src/realtime/cacheInvalidation.ts"),
    read("src/realtime/socketio.ts"),
    read("src/realtime/websocket.ts"),
    read("src/realtime/ws-broadcast.ts"),
  ]);

  assert.match(cacheBus, /cache:\s*"user-credentials"/);
  assert.match(cacheBus, /dispatchCacheInvalidation\(target\)/);
  assert.match(cacheBus, /publishCacheInvalidation\(target\)/);

  assert.match(socketIo, /target\.cache\s*!==\s*"user-credentials"/);
  assert.match(socketIo, /socket\.disconnect\(true\)/);
  assert.match(socketIo, /credentialVersionMatches\(socket\.data\.authVersion/);
  assert.match(socketIo, /SOCKET_CREDENTIAL_REVALIDATION_MS\s*=\s*30_000/);
  assert.match(socketIo, /const current = await getUserById\(userId\)/);
  assert.match(socketIo, /clearInterval\(credentialTimer\)/);

  assert.match(webSocket, /closeStaffUserSocketsLocal\(target\.userId\)/);
  assert.match(webSocket, /credentialVersionMatches\(client\.authVersion/);
  assert.match(webSocket, /const currentUser = await getUserById\(userId\)/);
  assert.match(webSocket, /credentialVersionMatches\(authenticatedClient\.authVersion/);
  assert.match(wsBroadcast, /code:\s*"CREDENTIAL_INVALIDATED"/);
  assert.match(wsBroadcast, /ws\.close\(1008,\s*"Credentials invalidated"\)/);
});

test("credential invalidation closes only the registered raw WebSocket identity", async () => {
  // Importing the server module registers the same local invalidation handler
  // used by a live API task; setupWebSocket itself is intentionally not called.
  await import("../src/realtime/websocket.js");

  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    const targetClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(targetClient, "open");
    const targetServerSocket = [...webSocketServer.clients][0];
    assert.ok(targetServerSocket);
    registerWsClient(targetServerSocket);
    authenticateWsClient(targetServerSocket, {
      role: "teacher",
      userId: "credential-target-user",
      schoolId: "credential-test-school",
      authVersion: 7,
    });

    const otherClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(otherClient, "open");
    const otherServerSocket = [...webSocketServer.clients].find(
      (candidate) => candidate !== targetServerSocket
    );
    assert.ok(otherServerSocket);
    registerWsClient(otherServerSocket);
    authenticateWsClient(otherServerSocket, {
      role: "teacher",
      userId: "other-user",
      schoolId: "credential-test-school",
      authVersion: 1,
    });

    const invalidationFrame = once(targetClient, "message");
    const targetClosed = once(targetClient, "close");
    dispatchCacheInvalidation({
      kind: "cache-invalidation",
      cache: "user-credentials",
      userId: "credential-target-user",
    });

    const [frame] = await invalidationFrame;
    const [closeCode, closeReason] = await targetClosed;
    assert.deepEqual(JSON.parse(frame.toString()), {
      type: "auth-error",
      message: "Credentials have changed. Sign in again.",
      code: "CREDENTIAL_INVALIDATED",
    });
    assert.equal(closeCode, 1008);
    assert.equal(closeReason.toString(), "Credentials invalidated");
    assert.equal(getWsClient(targetServerSocket), undefined);
    assert.equal(otherClient.readyState, WebSocket.OPEN);
    assert.equal(getWsClient(otherServerSocket)?.authenticated, true);

    otherClient.close();
    await once(otherClient, "close");
  } finally {
    for (const socket of webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
});
