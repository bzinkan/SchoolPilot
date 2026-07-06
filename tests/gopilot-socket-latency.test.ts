import assert from "node:assert/strict";
import test from "node:test";
import {
  isClassPilotWebSocketPath,
  isGoPilotSocketIoPath,
} from "../src/realtime/websocketPaths.js";

test("raw ClassPilot WebSocket path checks leave GoPilot Socket.IO upgrades alone", () => {
  assert.equal(isClassPilotWebSocketPath("/ws"), true);
  assert.equal(isClassPilotWebSocketPath("/ws/"), true);
  assert.equal(isClassPilotWebSocketPath("/gopilot-socket"), false);
  assert.equal(isClassPilotWebSocketPath("/gopilot-socket/"), false);

  assert.equal(isGoPilotSocketIoPath("/gopilot-socket"), true);
  assert.equal(isGoPilotSocketIoPath("/gopilot-socket/"), true);
  assert.equal(isGoPilotSocketIoPath("/ws"), false);
  assert.equal(isGoPilotSocketIoPath("/api/health"), false);
});
