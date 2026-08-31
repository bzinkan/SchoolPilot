import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  authenticateWsClient,
  registerWsClient,
  removeWsClient,
  sendToStudentBindingLocal,
} from "../src/realtime/ws-broadcast.js";

test("deferred exact-binding fanout excludes a same-binding legacy socket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const connect = async () => {
    const accepted = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");
    const [serverSocket] = await accepted;
    return { client, serverSocket };
  };

  const legacy = await connect();
  const capable = await connect();
  const binding = {
    schoolId: "capability-filter-school",
    studentId: "capability-filter-student",
    studentSessionId: "capability-filter-session",
    deviceId: "capability-filter-device",
  };
  for (const [connection, acceptedCapabilities] of [
    [legacy, []],
    [capable, ["lateSignInRestrictionSsoV1"]],
  ] as const) {
    registerWsClient(connection.serverSocket);
    authenticateWsClient(connection.serverSocket, {
      role: "student",
      ...binding,
      acceptedCapabilities: [...acceptedCapabilities],
    });
  }

  try {
    const capableDeferred = once(capable.client, "message");
    let legacyDeferredCount = 0;
    const onLegacyDeferred = () => { legacyDeferredCount += 1; };
    legacy.client.on("message", onLegacyDeferred);
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "classroom-state-sync",
      _msgId: "deferred-capability-filter",
      classroomState: {
        deliveryContext: { lateSignInRestrictionSso: true },
      },
    }), true);
    const [deferredFrame] = await capableDeferred;
    assert.equal(JSON.parse(deferredFrame.toString())._msgId, "deferred-capability-filter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(legacyDeferredCount, 0);
    legacy.client.off("message", onLegacyDeferred);

    const capableExpiredClear = once(capable.client, "message");
    let legacyExpiredCount = 0;
    const onLegacyExpired = () => { legacyExpiredCount += 1; };
    legacy.client.on("message", onLegacyExpired);
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "classroom-state",
      _msgId: "expired-deferred-capability-filter",
      // Expired stamped rows intentionally omit the SSO landing trigger while
      // retaining their capability requirement for the empty revision.
      classroomState: { revision: 2, restrictions: {} },
    }, {
      requiredCapability: "lateSignInRestrictionSsoV1",
    }), true);
    const [expiredFrame] = await capableExpiredClear;
    assert.equal(JSON.parse(expiredFrame.toString())._msgId, "expired-deferred-capability-filter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(legacyExpiredCount, 0);
    legacy.client.off("message", onLegacyExpired);

    const legacyOrdinary = once(legacy.client, "message");
    const capableOrdinary = once(capable.client, "message");
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "remote-control",
      _msgId: "ordinary-capability-filter",
      classroomState: { revision: 3 },
    }), true);
    const [[legacyFrame], [capableFrame]] = await Promise.all([
      legacyOrdinary,
      capableOrdinary,
    ]);
    assert.equal(JSON.parse(legacyFrame.toString())._msgId, "ordinary-capability-filter");
    assert.equal(JSON.parse(capableFrame.toString())._msgId, "ordinary-capability-filter");
  } finally {
    removeWsClient(legacy.serverSocket);
    removeWsClient(capable.serverSocket);
    legacy.client.terminate();
    capable.client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
