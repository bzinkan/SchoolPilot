import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  authenticateWsClient,
  broadcastToStudentsLocal,
  classpilotStudentFrameCarriesPreciseRestriction,
  registerWsClient,
  removeWsClient,
  sendToDeviceLocal,
  sendToRoleLocal,
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
  const authCapable = await connect();
  const dualCapable = await connect();
  const previewCapable = await connect();
  const binding = {
    schoolId: "capability-filter-school",
    studentId: "capability-filter-student",
    studentSessionId: "capability-filter-session",
    deviceId: "capability-filter-device",
  };
  for (const [connection, acceptedCapabilities] of [
    [legacy, []],
    [capable, ["lateSignInRestrictionSsoV1"]],
    [authCapable, ["restrictionAuthPassThroughV1"]],
    [dualCapable, ["lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1"]],
    [previewCapable, ["screenshotActiveObservationCadenceV1"]],
  ] as const) {
    registerWsClient(connection.serverSocket);
    authenticateWsClient(connection.serverSocket, {
      role: "student",
      ...binding,
      acceptedCapabilities: [...acceptedCapabilities],
    });
  }

  try {
    const previewRefresh = once(previewCapable.client, "message");
    let otherRefreshCount = 0;
    const countOtherRefresh = () => { otherRefreshCount += 1; };
    legacy.client.on("message", countOtherRefresh);
    capable.client.on("message", countOtherRefresh);
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "screenshot-policy-refresh",
      _msgId: "preview-capability-filter",
      reason: "observation_changed",
    }, {
      requiredCapability: "screenshotActiveObservationCadenceV1",
    }), true);
    const [previewFrame] = await previewRefresh;
    assert.equal(JSON.parse(previewFrame.toString())._msgId, "preview-capability-filter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(otherRefreshCount, 0);
    legacy.client.off("message", countOtherRefresh);
    capable.client.off("message", countOtherRefresh);

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

    const authLive = once(authCapable.client, "message");
    const dualLive = once(dualCapable.client, "message");
    let oldOnlyAuthCount = 0;
    capable.client.on("message", () => { oldOnlyAuthCount += 1; });
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "classroom-state-sync",
      _msgId: "auth-pass-through-capability-filter",
      classroomState: {
        authPassThrough: { schemaVersion: 1 },
      },
    }), true);
    await Promise.all([authLive, dualLive]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(oldOnlyAuthCount, 0);

    const dualDeferredAuth = once(dualCapable.client, "message");
    let singleCapabilityCount = 0;
    const countSingleCapability = () => { singleCapabilityCount += 1; };
    capable.client.on("message", countSingleCapability);
    authCapable.client.on("message", countSingleCapability);
    assert.equal(sendToStudentBindingLocal(binding, {
      type: "classroom-state-sync",
      _msgId: "dual-capability-filter",
      classroomState: {
        deliveryContext: { lateSignInRestrictionSso: true },
        authPassThrough: { schemaVersion: 1 },
      },
    }), true);
    const [dualFrame] = await dualDeferredAuth;
    assert.equal(JSON.parse(dualFrame.toString())._msgId, "dual-capability-filter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(singleCapabilityCount, 0);
    capable.client.off("message", countSingleCapability);
    authCapable.client.off("message", countSingleCapability);

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
    removeWsClient(authCapable.serverSocket);
    removeWsClient(dualCapable.serverSocket);
    removeWsClient(previewCapable.serverSocket);
    legacy.client.terminate();
    capable.client.terminate();
    authCapable.client.terminate();
    dualCapable.client.terminate();
    previewCapable.client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PR 2-pre fence: precise restriction frames reach no student socket, whatever it negotiated", async () => {
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
  const binding = {
    schoolId: "precise-fence-school",
    studentId: "precise-fence-student",
    studentSessionId: "precise-fence-session",
    deviceId: "precise-fence-device",
  };
  const legacy = await connect();
  // A socket can only hold names the server registry accepts. Even a spoofed
  // record of the future capability must not unlock precise delivery here.
  const spoofed = await connect();
  for (const [connection, acceptedCapabilities] of [
    [legacy, []],
    [spoofed, [
      "lateSignInRestrictionSsoV1",
      "restrictionAuthPassThroughV1",
      "preciseRestrictionResourcesV1",
      "focusTabV1",
    ]],
  ] as const) {
    registerWsClient(connection.serverSocket);
    authenticateWsClient(connection.serverSocket, {
      role: "student",
      ...binding,
      acceptedCapabilities: [...acceptedCapabilities],
    });
  }
  const received: string[] = [];
  for (const connection of [legacy, spoofed]) {
    connection.client.on("message", (frame: Buffer) => { received.push(frame.toString()); });
  }
  const docsResource = {
    type: "resource",
    hostname: "docs.google.com",
    includeSubdomains: false,
    provider: "google_docs",
    resourceId: "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ",
    canonicalUrl: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit",
  };
  const preciseFrames = [
    {
      type: "classroom-state-sync",
      _msgId: "precise-waypoint-state",
      classroomState: {
        revision: 9,
        restrictions: { screenLock: { active: true, url: docsResource.canonicalUrl, resource: docsResource } },
      },
    },
    {
      type: "classroom-state",
      _msgId: "precise-flight-path-state",
      classroomState: {
        revision: 10,
        restrictions: { flightPath: { active: true, allowedDomains: [], resources: [docsResource] } },
      },
    },
    {
      // Bare legacy frame: ClassPilot 2.9.x would apply data.url as a lock on
      // all of docs.google.com.
      type: "remote-control",
      _msgId: "precise-bare-waypoint",
      command: { type: "lock-screen", data: { url: docsResource.canonicalUrl, resource: docsResource } },
    },
    {
      type: "remote-control",
      _msgId: "precise-bare-flight-path",
      command: { type: "apply-flight-path", data: { allowedDomains: ["khanacademy.org"], resources: "malformed" } },
    },
  ];

  try {
    for (const frame of preciseFrames) {
      assert.equal(classpilotStudentFrameCarriesPreciseRestriction(frame), true, frame._msgId);
      assert.equal(sendToStudentBindingLocal(binding, frame), false, frame._msgId);
      // A relayed envelope names its requirement explicitly; the fence still wins.
      assert.equal(sendToStudentBindingLocal(binding, frame, {
        requiredCapabilities: ["preciseRestrictionResourcesV1"],
      }), false, frame._msgId);
      assert.equal(sendToDeviceLocal(binding.schoolId, binding.deviceId, frame), false, frame._msgId);
      assert.equal(broadcastToStudentsLocal(binding.schoolId, frame), 0, frame._msgId);
      sendToRoleLocal(binding.schoolId, "student", frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(received, [], "no precise frame reached any student socket");

    // Ordinary frames, including Lesson Activity resources, are untouched and
    // byte-identical on the wire.
    const lesson = {
      type: "remote-control",
      _msgId: "lesson-resources-unchanged",
      command: {
        type: "lesson-activity",
        data: { action: "start", title: "Read", resources: [{ url: docsResource.canonicalUrl }] },
      },
    };
    const legacyWaypoint = {
      type: "remote-control",
      _msgId: "legacy-waypoint-unchanged",
      command: { type: "lock-screen", data: { url: "https://www.ixl.com/math" } },
      classroomState: {
        revision: 11,
        restrictions: { screenLock: { active: true, url: "https://www.ixl.com/math" } },
      },
    };
    for (const frame of [lesson, legacyWaypoint]) {
      assert.equal(classpilotStudentFrameCarriesPreciseRestriction(frame), false, frame._msgId);
      const delivered = Promise.all([once(legacy.client, "message"), once(spoofed.client, "message")]);
      assert.equal(sendToStudentBindingLocal(binding, frame), true, frame._msgId);
      const frames = await delivered;
      for (const [payload] of frames) assert.equal(String(payload), JSON.stringify(frame));
    }
  } finally {
    removeWsClient(legacy.serverSocket);
    removeWsClient(spoofed.serverSocket);
    legacy.client.terminate();
    spoofed.client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
