import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { createClasspilotLiveViewNegotiationId, verifyClasspilotLiveViewNegotiation,
  classpilotLiveViewNegotiationAuthority, claimClasspilotLiveViewNegotiation,
  isClasspilotLiveViewNegotiationActive, releaseClasspilotLiveViewNegotiation,
} from "../src/services/classpilotLiveViewNegotiation.js";
import { parseClasspilotSessionSubscription } from "../src/services/classpilotSessionSubscription.js";
import { classpilotLiveViewBindingMatchesSnapshot } from "../src/services/classpilotLiveViewRevocation.js";
import { registerWsClient, authenticateWsClient, subscribeWsClientToSession, subscribeWsClientToContext,
  unsubscribeWsClientFromContext, broadcastToStaffContextLocal, broadcastToStaffSessionLocal, resetWsState,
} from "../src/realtime/ws-broadcast.js";

test("scheduled Live View signs exclusive authority, exact ownership and the scheduled boundary", async () => {
  const binding = { schoolId: "scheduled-live-school", studentId: "student", studentSessionId: "browser-session",
    deviceId: "browser-device", supervisionContextId: "same-id", controlRevision: 7,
    requesterUserId: "assigned-staff", authorityExpiresAt: 12_000 };
  const issued = createClasspilotLiveViewNegotiationId(binding, 10_000);
  assert.equal(issued.expiresAt, 12_000);
  assert.equal(verifyClasspilotLiveViewNegotiation(issued.negotiationId, binding, 10_001), true);
  for (const changed of [{ ...binding, controlRevision: 8 }, { ...binding, studentSessionId: "replacement" },
    { ...binding, deviceId: "replacement" }, { ...binding, schoolId: "another-school" },
    { ...binding, studentId: "another-student" }, { ...binding, requesterUserId: "another-staff" },
    { ...binding, supervisionContextId: undefined, teachingSessionId: "same-id" }]) {
    assert.equal(verifyClasspilotLiveViewNegotiation(issued.negotiationId, changed, 10_001), false);
  }
  assert.equal(verifyClasspilotLiveViewNegotiation(issued.negotiationId, binding, 12_000), false);
  assert.throws(() => createClasspilotLiveViewNegotiationId({ ...binding, teachingSessionId: "same-id" }, 10_000));
  assert.throws(() => createClasspilotLiveViewNegotiationId({ ...binding, controlRevision: undefined }, 10_000));
  assert.throws(() => createClasspilotLiveViewNegotiationId(binding, 12_000));
  assert.deepEqual(classpilotLiveViewNegotiationAuthority(issued.negotiationId, binding, 10_001), {
    supervisionContextId: "same-id", controlRevision: 7, requesterUserId: "assigned-staff", expiresAt: 12_000,
  });
  const claim = await claimClasspilotLiveViewNegotiation(binding, 10_000);
  assert.equal(claim.status, "claimed");
  if (claim.status !== "claimed") return;
  assert.equal(await isClasspilotLiveViewNegotiationActive(binding, claim.negotiationId, 10_001), true);
  await releaseClasspilotLiveViewNegotiation(binding, claim.negotiationId);
  assert.equal(await isClasspilotLiveViewNegotiationActive(binding, claim.negotiationId, 10_002), false);
});

test("typed subscriptions reject mixed IDs and never fan context events into same-named teaching sessions", async () => {
  assert.deepEqual(parseClasspilotSessionSubscription({ type: "subscribe-session", supervisionContextId: "same-id", contextAuthorityRevision: "0", requestId: "request-1" }),
    { ok: true, action: "subscribe", supervisionContextId: "same-id", contextAuthorityRevision: "0", requestId: "request-1" });
  for (const contextAuthorityRevision of [undefined, null, 0, "", "00", "-1", " 0", "1.0", "9007199254740992"]) {
    assert.equal(parseClasspilotSessionSubscription({ type: "subscribe-session", supervisionContextId: "same-id", contextAuthorityRevision }).ok, false);
  }
  assert.deepEqual(parseClasspilotSessionSubscription({ type: "unsubscribe-session", supervisionContextId: "same-id" }),
    { ok: true, action: "unsubscribe", supervisionContextId: "same-id" });
  assert.equal(parseClasspilotSessionSubscription({ type: "subscribe-session", supervisionContextId: "same-id", sessionId: "same-id" }).ok, false);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const clients: WebSocket[] = [];
  const socket = async () => {
    const accepted = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    clients.push(client);
    await once(client, "open");
    const [ws] = await accepted;
    assert.ok(ws instanceof WebSocket);
    return { ws, client };
  };
  const contextSocket = await socket(), teachingSocket = await socket(), otherSocket = await socket();
  const context = contextSocket.ws, teaching = teachingSocket.ws, other = otherSocket.ws;
  try {
    for (const [ws, schoolId] of [[context, "school"], [teaching, "school"], [other, "other-school"]] as const) {
      registerWsClient(ws); authenticateWsClient(ws, { role: "teacher", schoolId, userId: "teacher" });
    }
    subscribeWsClientToContext(context, "same-id", "0"); subscribeWsClientToSession(teaching, "same-id");
    subscribeWsClientToContext(other, "same-id", "0");
    const contextMessage = once(contextSocket.client, "message");
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update", teachingSessionId: "wrong", sessionId: "wrong" }, "teacher", "0"), 1);
    const [received] = await contextMessage;
    assert.deepEqual(JSON.parse(String(received)), { type: "hand-update", supervisionContextId: "same-id", contextAuthorityRevision: "0" });
    const teachingMessage = once(teachingSocket.client, "message");
    assert.equal(broadcastToStaffSessionLocal("school", "same-id", { type: "hand-update" }), 1);
    const [teachingReceived] = await teachingMessage;
    assert.deepEqual(JSON.parse(String(teachingReceived)), { type: "hand-update", teachingSessionId: "same-id" });
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "reassigned-staff", "1"), 0);
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "teacher", "2"), 0,
      "A previous subscription must not revive when the original teacher is reassigned");
    subscribeWsClientToContext(context, "same-id", "2");
    const renewedMessage = once(contextSocket.client, "message");
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "teacher", "2"), 1);
    await renewedMessage;
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "teacher", "0"), 0,
      "Delayed publications from the previous assignment cannot reach the renewed subscription");
    unsubscribeWsClientFromContext(context, "same-id");
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "teacher", "2"), 0);
    subscribeWsClientToContext(context, "same-id", "2");
    authenticateWsClient(context, { role: "teacher", schoolId: "school", userId: "new-staff" });
    assert.equal(broadcastToStaffContextLocal("school", "same-id", { type: "hand-update" }, "teacher", "2"), 0);
  } finally {
    resetWsState();
    for (const client of clients) client.terminate();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("post-commit Live View invalidation preserves unaffected authority and rejects released, replaced or expired bindings", () => {
  const binding = { schoolId: "school", studentId: "student-a", studentSessionId: "login-a", deviceId: "device-a",
    supervisionContextId: "testing", controlRevision: 9, requesterUserId: "teacher" };
  const state = { teachingSessionId: null, supervisionContextId: "testing", revision: 9,
    hardExpiresAt: new Date(20_000), scheduledEndAt: new Date(15_000) };
  const session = { id: "login-a", deviceId: "device-a" };
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, state, session, 10_000), true);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, { ...state, revision: 10 }, session, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, { ...state, supervisionContextId: null }, session, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, { ...state, supervisionContextId: "testing-b" }, session, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, state, { ...session, id: "login-b" }, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, state, { ...session, deviceId: "device-b" }, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, state, undefined, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, undefined, session, 10_000), false);
  assert.equal(classpilotLiveViewBindingMatchesSnapshot(binding, state, session, 15_000), false);
});
