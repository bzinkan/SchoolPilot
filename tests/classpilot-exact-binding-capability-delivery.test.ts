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

test("precise restriction frames reach only exact-bound sockets that accepted preciseRestrictionResourcesV1", async () => {
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
  // Three sockets on the same exact binding: no capabilities, the set a
  // ClassPilot 2.9.6 client negotiates (sign-in safe, focusTabV1 spoofed in),
  // and a 2.10.0 client that ACCEPTED the precise capability.
  const legacy = await connect();
  const signInSafe = await connect();
  const capable = await connect();
  for (const [connection, acceptedCapabilities] of [
    [legacy, []],
    [signInSafe, ["lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1", "focusTabV1"]],
    [capable, ["lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1", "preciseRestrictionResourcesV1"]],
  ] as const) {
    registerWsClient(connection.serverSocket);
    authenticateWsClient(connection.serverSocket, {
      role: "student",
      ...binding,
      acceptedCapabilities: [...acceptedCapabilities],
    });
  }
  const received = new Map<string, string[]>([["legacy", []], ["signInSafe", []], ["capable", []]]);
  for (const [name, connection] of [["legacy", legacy], ["signInSafe", signInSafe], ["capable", capable]] as const) {
    connection.client.on("message", (frame: Buffer) => { received.get(name)!.push(frame.toString()); });
  }
  const docsResource = {
    type: "resource",
    hostname: "docs.google.com",
    includeSubdomains: false,
    provider: "google_docs",
    resourceId: "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ",
    canonicalUrl: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit",
  };
  const waypointState = {
    revision: 9,
    restrictions: { screenLock: { active: true, url: docsResource.canonicalUrl, resource: docsResource } },
  };
  const deliverable = [
    { type: "classroom-state-sync", _msgId: "precise-waypoint-state", classroomState: waypointState },
    {
      type: "classroom-state",
      _msgId: "precise-flight-path-state",
      classroomState: {
        revision: 10,
        restrictions: { flightPath: { active: true, allowedDomains: [], resources: [docsResource] } },
      },
    },
    {
      // A stateful command frame travels with its authoritative snapshot.
      type: "remote-control",
      _msgId: "precise-waypoint-command",
      command: { type: "lock-screen", data: { url: docsResource.canonicalUrl, resource: docsResource } },
      classroomState: waypointState,
    },
  ];
  const neverDelivered = [
    {
      // Bare legacy frame: ClassPilot 2.9.x would apply data.url as a lock on
      // all of docs.google.com, so it is refused even for a capable socket.
      type: "remote-control",
      _msgId: "precise-bare-waypoint",
      command: { type: "lock-screen", data: { url: docsResource.canonicalUrl, resource: docsResource } },
    },
    {
      type: "remote-control",
      _msgId: "precise-bare-flight-path",
      command: { type: "apply-flight-path", data: { allowedDomains: ["khanacademy.org"], resources: "malformed" } },
    },
    {
      // Entries that fail re-validation are withheld from every socket.
      type: "classroom-state-sync",
      _msgId: "precise-malformed-state",
      classroomState: {
        revision: 12,
        restrictions: {
          flightPath: {
            active: true,
            allowedDomains: [],
            resources: [{ ...docsResource, canonicalUrl: "https://evil.example.com/" }],
          },
        },
      },
    },
    {
      // A Waypoint whose url is not its resource's canonical URL is out of contract.
      type: "classroom-state-sync",
      _msgId: "precise-mismatched-waypoint",
      classroomState: {
        revision: 13,
        restrictions: { screenLock: { active: true, url: "https://docs.google.com/", resource: docsResource } },
      },
    },
    {
      // Like the dispatcher's frame builder: a precise command never rides on
      // a plain snapshot, even one that is itself deliverable.
      type: "remote-control",
      _msgId: "precise-command-on-plain-snapshot",
      command: { type: "lock-screen", data: { url: docsResource.canonicalUrl, resource: docsResource } },
      classroomState: {
        revision: 14,
        restrictions: { screenLock: { active: true, url: "https://www.ixl.com/math" } },
      },
    },
  ];

  try {
    for (const frame of [...deliverable, ...neverDelivered]) {
      assert.equal(classpilotStudentFrameCarriesPreciseRestriction(frame), true, frame._msgId);
      // Non-exact surfaces never carry precise restrictions.
      assert.equal(sendToDeviceLocal(binding.schoolId, binding.deviceId, frame), false, frame._msgId);
      assert.equal(broadcastToStudentsLocal(binding.schoolId, frame), 0, frame._msgId);
      sendToRoleLocal(binding.schoolId, "student", frame);
    }
    for (const frame of neverDelivered) {
      assert.equal(sendToStudentBindingLocal(binding, frame), false, frame._msgId);
      assert.equal(sendToStudentBindingLocal(binding, frame, {
        requiredCapabilities: ["preciseRestrictionResourcesV1"],
      }), false, frame._msgId);
    }
    for (const [index, frame] of deliverable.entries()) {
      const arrived = once(capable.client, "message");
      // An explicit (or relayed) requirement can narrow delivery but never
      // waive the capability the frame itself needs.
      const options = index === 0 ? {} : { requiredCapabilities: ["restrictionAuthPassThroughV1"] };
      assert.equal(sendToStudentBindingLocal(binding, frame, options), true, frame._msgId);
      const [payload] = await arrived;
      assert.equal(String(payload), JSON.stringify(frame), "a capable socket receives the frame byte-for-byte");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(received.get("legacy"), [], "no precise frame reached a socket without capabilities");
    assert.deepEqual(received.get("signInSafe"), [], "no precise frame reached a 2.9.6-shaped socket");
    assert.equal(received.get("capable")!.length, deliverable.length, "only valid snapshots reached the capable socket");

    // Ordinary frames, including Lesson Activity resources, are untouched and
    // byte-identical on the wire for every socket.
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
      const delivered = Promise.all([
        once(legacy.client, "message"),
        once(signInSafe.client, "message"),
        once(capable.client, "message"),
      ]);
      assert.equal(sendToStudentBindingLocal(binding, frame), true, frame._msgId);
      const frames = await delivered;
      for (const [payload] of frames) assert.equal(String(payload), JSON.stringify(frame));
    }
  } finally {
    for (const connection of [legacy, signInSafe, capable]) {
      removeWsClient(connection.serverSocket);
      connection.client.terminate();
    }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
