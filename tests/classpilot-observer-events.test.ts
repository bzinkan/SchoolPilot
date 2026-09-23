import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { classpilotObserverEvent } from "../src/services/classpilotObserverEvents.js";
import { parseClasspilotSessionSubscription } from "../src/services/classpilotSessionSubscription.js";
import { authenticateWsClient, broadcastToStaffContextLocal, broadcastToStaffSessionLocal, registerWsClient,
  resetWsState, subscribeWsClientToContext, subscribeWsClientToSession, unsubscribeWsClientFromContext } from "../src/realtime/ws-broadcast.js";

test("observer projection denies private event types and nested data in monitoring frames", () => {
  for (const type of ["chat-message", "chat-message-delivery", "hand-update", "poll-response", "class-tools-state", "unknown"]) {
    assert.equal(classpilotObserverEvent({ type, studentId: "s", content: "private" }), null);
  }
  assert.deepEqual(classpilotObserverEvent({ type: "student-update", studentId: "s", realtimeRevision: 2,
    activeTabTitle: "Lesson", classroomState: { message: "private" }, help: "private", deviceId: "secret",
    aiClassification: { explanation: "private" }, activeTabUrl: { nested: "private" } }),
  { type: "student-update", studentId: "s", realtimeRevision: 2, activeTabTitle: "Lesson" });
  assert.deepEqual(parseClasspilotSessionSubscription({ type: "subscribe-session", supervisionContextId: "c",
    contextAuthorityRevision: "2", accessMode: "observe" }),
  { ok: true, action: "subscribe", supervisionContextId: "c", contextAuthorityRevision: "2", accessMode: "observe" });
  assert.equal(parseClasspilotSessionSubscription({ type: "subscribe-session", sessionId: "c", accessMode: "edit" }).ok, false);
});

test("owner and observer receive one bounded screenshot event; private, stale, foreign and unsubscribed events stay hidden", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const peers: Array<{ server: WebSocket; client: WebSocket; messages: unknown[] }> = [];
  const connect = async (userId: string, schoolId = "school", role: "teacher" | "school_admin" = "school_admin") => {
    const accepted = once(server, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");
    const [socket] = await accepted;
    assert.ok(socket instanceof WebSocket);
    const messages: unknown[] = [];
    client.on("message", value => messages.push(JSON.parse(String(value))));
    registerWsClient(socket); authenticateWsClient(socket, { role, schoolId, userId });
    const peer = { server: socket, client, messages }; peers.push(peer); return peer;
  };
  try {
    const owner = await connect("owner", "school", "teacher");
    const observer = await connect("observer");
    const foreign = await connect("foreign", "other-school");
    for (const peer of [observer, foreign]) subscribeWsClientToContext(peer.server, "context", "2", true);
    const frame = { type: "screenshot-available", studentId: "student", timestamp: 1, privateContent: "hidden" };
    const received = once(observer.client, "message");
    assert.equal(broadcastToStaffContextLocal("school", "context", frame, "owner", "2", "owner-and-observers"), 2);
    await received;
    assert.equal(observer.messages.length, 1);
    assert.deepEqual(observer.messages[0], { type: "screenshot-available", supervisionContextId: "context",
      contextAuthorityRevision: "2", studentId: "student", timestamp: 1 });
    subscribeWsClientToContext(owner.server, "context", "2");
    assert.equal(broadcastToStaffContextLocal("school", "context", frame, "owner", "2", "owner-and-observers"), 2,
      "An owner subscribed as well must receive only one copy");
    assert.equal(broadcastToStaffContextLocal("school", "context", { type: "chat-message", content: "private" }, "owner", "2"), 1);
    assert.equal(broadcastToStaffContextLocal("school", "context", frame, "owner", "1"), 0);
    unsubscribeWsClientFromContext(observer.server, "context");
    assert.equal(broadcastToStaffContextLocal("school", "context", frame, "owner", "2"), 1);
    subscribeWsClientToSession(observer.server, "class", true);
    subscribeWsClientToSession(owner.server, "class");
    assert.equal(broadcastToStaffSessionLocal("school", "class", { type: "hand-update" }), 1);
    assert.equal(broadcastToStaffSessionLocal("school", "class", frame), 2);
    authenticateWsClient(observer.server, { role: "school_admin", schoolId: "other-school", userId: "observer" });
    assert.equal(broadcastToStaffSessionLocal("school", "class", frame), 1);
    assert.equal(foreign.messages.length, 0);
  } finally {
    resetWsState();
    for (const peer of peers) { peer.client.terminate(); peer.server.terminate(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
