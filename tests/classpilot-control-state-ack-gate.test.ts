import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  classpilotControlStateAckExpectedHealth,
  classpilotControlStateAckRequired,
} from "../src/services/classpilotControlStateAckGate.js";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return value.slice(startIndex, endIndex);
}

const synced = { appliedRevision: 7, enforcementHealth: "synced" as const };

function ack(overrides: Partial<Parameters<typeof classpilotControlStateAckRequired>[0]> = {}) {
  return classpilotControlStateAckRequired({
    controlState: synced,
    appliedRevision: 7,
    outcome: "applied",
    lateSignInOriginPending: false,
    restrictionAuthRevisionMismatch: false,
    ...overrides,
  });
}

describe("ClassPilot classroom-state ACK gate", () => {
  it("maps every ACK outcome to the enforcement health the storage ACK records", () => {
    assert.equal(classpilotControlStateAckExpectedHealth("applied"), "synced");
    assert.equal(classpilotControlStateAckExpectedHealth("failed"), "failed");
    assert.equal(classpilotControlStateAckExpectedHealth("unsupported"), "unsupported");
    assert.equal(classpilotControlStateAckExpectedHealth("expired"), "expired");
  });

  it("skips an unchanged ACK so an unchanged re-push performs no write", () => {
    assert.equal(ack(), false);
    assert.equal(ack({
      controlState: { appliedRevision: 7, enforcementHealth: "failed" },
      outcome: "failed",
    }), false);
    assert.equal(ack({
      controlState: { appliedRevision: 7, enforcementHealth: "expired" },
      outcome: "expired",
    }), false);
  });

  it("acknowledges when the reported revision differs from the applied revision", () => {
    assert.equal(ack({ appliedRevision: 8 }), true);
    assert.equal(ack({ controlState: { appliedRevision: null, enforcementHealth: "pending" } }), true);
    assert.equal(ack({ controlState: { appliedRevision: 6, enforcementHealth: "synced" } }), true);
  });

  it("acknowledges when the reported outcome changes enforcement health", () => {
    assert.equal(ack({ controlState: { appliedRevision: 7, enforcementHealth: "pending" } }), true);
    assert.equal(ack({ outcome: "failed" }), true);
    assert.equal(ack({ outcome: "unsupported" }), true);
    assert.equal(ack({ outcome: "expired" }), true);
    assert.equal(ack({
      controlState: { appliedRevision: 7, enforcementHealth: "failed" },
      outcome: "applied",
    }), true);
  });

  it("acknowledges when the client-applied SSO fence mismatches the current projection", () => {
    assert.equal(ack({ restrictionAuthRevisionMismatch: true }), true);
  });

  it("acknowledges while a late-sign-in origin still awaits its applied binding", () => {
    assert.equal(ack({ lateSignInOriginPending: true }), true);
  });
});

describe("ClassPilot classroom-state ACK surfaces share one gate", () => {
  it("gates the heartbeat ACK through the shared predicate", () => {
    const devices = source("../src/routes/classpilot/devices.ts");
    const heartbeatAck = section(
      devices,
      "const [heartbeat, controlState] = await Promise.all",
      "const screenshotTrackingAuthority",
    );
    assert.match(
      heartbeatAck,
      /classpilotControlStateAckRequired\(\{[\s\S]*?controlState,[\s\S]*?restrictionAuthRevisionMismatch,[\s\S]*?\}\)[\s\S]*?acknowledgeClasspilotStudentControlState\(\{/,
    );
    assert.doesNotMatch(
      heartbeatAck,
      /controlState\.enforcementHealth !== expectedHealth/,
      "the heartbeat must not keep a private copy of the skip predicate",
    );
  });

  it("gates the WebSocket ACK through the same predicate before any write", () => {
    const websocket = source("../src/realtime/websocket.ts");
    const websocketAck = section(
      websocket,
      'message.type === "classroom-state-ack"',
      'message.type === "classroom-state-request"',
    );
    assert.match(
      websocketAck,
      /getClasspilotStudentControlState\([\s\S]*?classpilotLateSignInRevisionAppliedToBinding\([\s\S]*?classpilotControlStateAckRequired\(\{[\s\S]*?if \(!ackRequired\) return undefined;[\s\S]*?acknowledgeClasspilotStudentControlState\(\{/,
      "an unchanged WebSocket ACK must return before the storage ACK writes",
    );
    assert.equal(
      websocketAck.match(/acknowledgeClasspilotStudentControlState\(/g)?.length,
      1,
      "the WebSocket ACK must have exactly one, gated, storage write path",
    );
    assert.match(
      websocketAck,
      /runWithTenantContext\(\{ schoolId: client\.schoolId \}, async \(\) => \{[\s\S]*?getClasspilotStudentControlState\(/,
      "the gate's unlocked reads must run inside the tenant lease",
    );
  });
});
